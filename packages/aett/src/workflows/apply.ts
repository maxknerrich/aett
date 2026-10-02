import { Console, Effect, Option, Schema } from "effect";
import { Prompt } from "effect/cli";
import type { Connection } from "../adapters/ssh.ts";
import { applyTargets } from "../domain/apply.ts";
import { type Fleet, guestsOf } from "../domain/fleet.ts";
import { type Entry, resolveHome } from "../domain/home.ts";
import type { Host } from "../domain/host.ts";
import type { State } from "../domain/state.ts";
import { type Build, Engine } from "../engine/engine.ts";
import { emit } from "./compile.ts";
import { applyHome, HomeError, planHome, readSets } from "./home.ts";
import { placeGuestKeys } from "./identity.ts";
import { connectGuest, connectMachine, recordTailnet } from "./reach.ts";

export class ApplyError extends Schema.TaggedError<ApplyError>()("ApplyError", {
	message: Schema.String,
}) {}

/** The answers `aett apply` takes as flags. */
export interface ApplyOptions {
	readonly host: Option.Option<Host>;
	readonly yes: boolean;
}

// What one run of apply works from, with each target's home: its dotfile sets merged.
interface Run {
	readonly root: string;
	readonly build: Build;
	readonly fleet: Fleet;
	readonly state: State;
	readonly homes: ReadonlyMap<string, ReadonlyArray<Entry>>;
	readonly yes: boolean;
}

/**
 * Brings machines to their declared systems: the named one, or else every
 * machine aett can apply to, hosts before their guests. Everything is
 * evaluated before any machine is contacted, and the first machine that
 * fails stops the run.
 */
export const apply = Effect.fn("apply")(function* (
	root: string,
	name: Option.Option<string>,
	options: ApplyOptions,
) {
	const engine = yield* Engine;

	if (Option.isSome(options.host) && Option.isNone(name)) {
		return yield* new ApplyError({
			message:
				"--host names one machine's address. Pass the machine too: aett apply <name> --host …",
		});
	}

	const { build, fleet, state } = yield* emit(root);

	const { targets, skipped } = yield* Effect.fromResult(applyTargets(fleet, state, name)).pipe(
		Effect.mapError((message) => new ApplyError({ message })),
	);

	const hosts = new Map(
		fleet.machines.flatMap(({ name: machine, vm }) =>
			Option.toArray(Option.map(vm, ({ host }) => [machine, host] as const)),
		),
	);

	if (Option.isSome(options.host) && targets.some((target) => hosts.has(target))) {
		return yield* new ApplyError({
			message: `--host names a bare-metal machine's address. aett reaches a VM through its host.`,
		});
	}

	yield* Effect.forEach(skipped, ({ name: machine, reason }) =>
		Console.log(`${machine} ${reason}, skipping it.`),
	);

	yield* Effect.forEach(targets, (machine) =>
		Console.log(`Evaluating ${machine}…`).pipe(Effect.andThen(engine.evaluate(build, machine))),
	);

	const sets = yield* readSets(root);

	const homes = new Map(
		yield* Effect.forEach(
			fleet.machines.filter(
				({ name: machine, home }) => targets.includes(machine) && home.length > 0,
			),
			({ name: machine, home }) =>
				Effect.fromResult(resolveHome(sets, home)).pipe(
					Effect.mapError(
						(problems) => new HomeError({ message: `${machine}'s home:\n${problems}` }),
					),
					Effect.map((entries) => [machine, entries] as const),
				),
		),
	);

	const run: Run = { root, build, fleet, state, homes, yes: options.yes };

	return yield* Effect.forEach(
		targets,
		(machine) => {
			const host = hosts.get(machine);

			return host === undefined
				? applyMachine(run, machine, options.host)
				: applyGuest(run, machine, host);
		},
		{ discard: true },
	);
});

// Builds a bare-metal machine's system on it and, once the operator agrees, switches to it. A
// host's guests get their host keys first, so the ones the switch starts find their identity, and
// the guests fleet.ts dropped stop once the host runs its new system.
const applyMachine = Effect.fn("applyMachine")(function* (
	run: Run,
	name: string,
	host: Option.Option<Host>,
) {
	const engine = yield* Engine;
	const connection = yield* connectMachine(run.root, run.state, name, host);

	const guests = guestsOf(run.fleet, name).filter((guest) => run.build.machines.includes(guest));

	yield* placeGuestKeys(run.root, connection, guests, run.state.operator.ageKeys);

	const system = yield* engine.buildSystem(run.build, name, connection);
	const current = yield* engine.currentSystem(connection);

	if (system === current) {
		yield* Console.log(`${name} is up to date.`);
		yield* settle(run, name, connection);

		return yield* stopDroppedGuests(run, name, connection);
	}

	const changes = yield* engine.changes(connection, current, system);

	yield* Console.log(
		changes === ""
			? `${name}'s new system changes no package versions.`
			: `Changes on ${name}:\n${changes}`,
	);

	if (!run.yes && !(yield* Prompt.Confirm({ message: `Switch ${name} to the new system?` }))) {
		return yield* Console.log(`Left ${name} as it is.`);
	}

	yield* Console.log(`Switching ${name}…`);
	yield* engine.activate(connection, system);
	yield* Console.log(`Switched ${name} to ${system}.`);
	yield* settle(run, name, connection);

	return yield* stopDroppedGuests(run, name, connection);
}, Effect.scoped);

// What follows once a machine runs its declared system: its home synced and its tailnet address recorded.
const settle = Effect.fn("settle")(function* (run: Run, name: string, connection: Connection) {
	yield* syncHome(run, name, connection);
	yield* recordTailnet(run.root, run.state, name, connection);
});

// Syncs the machine's dotfile sets into the user's home, asking first when files change.
const syncHome = Effect.fn("syncHome")(function* (run: Run, name: string, connection: Connection) {
	const entries = run.homes.get(name);
	const user = Option.getOrUndefined(run.fleet.user);

	if (entries === undefined || user === undefined) return yield* Effect.void;

	const sync = yield* planHome(connection, name, user, entries);

	if (
		sync.plan.changes &&
		!run.yes &&
		!(yield* Prompt.Confirm({ message: `Sync ${user}'s home on ${name}?` }))
	) {
		return yield* Console.log(`Left ${user}'s home on ${name} as it is.`);
	}

	return yield* applyHome(connection, sync);
});

// Stops the guests state places on `host` that fleet.ts no longer declares. Their data stays
// until aett machine destroy deletes it.
const stopDroppedGuests = Effect.fn("stopDroppedGuests")(function* (
	run: Run,
	host: string,
	connection: Connection,
) {
	const engine = yield* Engine;
	const declared = new Set(run.fleet.machines.map(({ name }) => name));

	const dropped = [...run.state.machines].flatMap(([name, record]) =>
		record.host === host && !declared.has(name) ? [name] : [],
	);

	yield* Effect.forEach(dropped, (guest) =>
		Effect.gen(function* () {
			if ((yield* engine.guestState(connection, guest)) !== "running") return;

			yield* Console.log(`Stopping ${guest}, which fleet.ts no longer declares…`);
			yield* engine.controlGuest(connection, guest, "stop");
			yield* Console.log(
				`Stopped ${guest}. Its data stays on ${host} until aett machine destroy ${guest}.`,
			);
		}),
	);
});

// Builds a guest's system on its host and brings the guest to it: starts it if it isn't
// running, switches it in place if it can, and restarts it, once the operator agrees, if
// what it boots with changed.
const applyGuest = Effect.fn("applyGuest")(function* (run: Run, name: string, host: string) {
	const engine = yield* Engine;
	const connection = yield* connectMachine(run.root, run.state, host, Option.none());

	yield* placeGuestKeys(run.root, connection, [name], run.state.operator.ageKeys);

	if ((yield* engine.guestState(connection, name)) === "absent") {
		return yield* Console.log(
			`${name} is new on ${host} and starts when ${host} switches to a system that lists it. Apply ${host} first.`,
		);
	}

	// The guest's LAN forwards are part of its host's system, which applying the guest leaves alone.
	const homed = run.fleet.machines.some(
		(machine) => machine.name === name && machine.home.length > 0,
	);

	if (
		homed &&
		(yield* engine.systemPath(run.build, host)) !== (yield* engine.currentSystem(connection))
	) {
		yield* Console.log(
			`${host} doesn't run what fleet.ts builds for it yet. It forwards ${name}'s SSH and mosh from the LAN, so apply ${host} too.`,
		);
	}

	const system = yield* engine.buildGuest(run.build, name, connection);

	// A guest that starts or restarts here is synced once it answers.
	const settleGuest = connectGuest(run.root, run.state, name, connection).pipe(
		Effect.flatMap((guest) => settle(run, name, guest)),
	);

	// Checked again after the build: a host switch that lists it for the first time starts it.
	if ((yield* engine.guestState(connection, name)) !== "running") {
		yield* Console.log(`Starting ${name}…`);
		yield* engine.controlGuest(connection, name, "start");
		yield* Console.log(`Started ${name} with ${system}.`);

		return yield* settleGuest;
	}

	const guest = yield* connectGuest(run.root, run.state, name, connection);
	const current = yield* engine.currentSystem(guest);

	if (current === system) {
		yield* Console.log(`${name} is up to date.`);

		return yield* settle(run, name, guest);
	}

	if (yield* engine.needsRestart(guest, system)) {
		yield* Console.log(
			`${name} has to restart for its new system: what it boots with changed, such as its kernel, CPUs or memory.`,
		);

		if (!run.yes && !(yield* Prompt.Confirm({ message: `Restart ${name} now?` }))) {
			return yield* Console.log(`${name} keeps running its current system until it restarts.`);
		}

		yield* Console.log(`Restarting ${name}…`);
		yield* engine.controlGuest(connection, name, "restart");
		yield* Console.log(`Restarted ${name} with ${system}.`);

		return yield* settleGuest;
	}

	const changes = yield* engine.changes(connection, current, system);

	yield* Console.log(
		changes === ""
			? `${name}'s new system changes no package versions.`
			: `Changes on ${name}:\n${changes}`,
	);

	if (!run.yes && !(yield* Prompt.Confirm({ message: `Switch ${name} to the new system?` }))) {
		return yield* Console.log(`Left ${name} as it is.`);
	}

	yield* Console.log(`Switching ${name}…`);
	yield* engine.switchGuest(connection, guest, name, system);
	yield* Console.log(`Switched ${name} to ${system}.`);

	return yield* settle(run, name, guest);
}, Effect.scoped);
