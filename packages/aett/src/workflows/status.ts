import { type Cause, Console, Effect, Option, Path, type PlatformError, type Scope } from "effect";
import { type Connection, Ssh, type SshError } from "../adapters/ssh.ts";
import { guestsOf } from "../domain/fleet.ts";
import type { Host } from "../domain/host.ts";
import type { State } from "../domain/state.ts";
import { pinFits } from "../domain/pins.ts";
import { Engine, type EngineError } from "../engine/engine.ts";
import { emitAsIs, notBuilt } from "./compile.ts";

// One way to a machine: how the line names it, and the login it takes.
interface Way {
	readonly label: string;
	readonly connect: Effect.Effect<
		Connection,
		SshError | EngineError | PlatformError.PlatformError | Cause.NoSuchElementError,
		Scope.Scope
	>;
}

// The first way in that answers, with its label; none when none does.
const reach = (ways: ReadonlyArray<Way>) =>
	Effect.firstSuccessOf(
		ways.map(({ label, connect }) => Effect.map(connect, (connection) => ({ label, connection }))),
	).pipe(Effect.option);

// The tailnet address state recorded for a machine, as an SSH endpoint.
const tailnetHost = (state: State, name: string) =>
	Option.map(Option.fromUndefinedOr(state.machines.get(name)?.tailnet), (address): Host => ({
		name: address,
		port: 22,
	}));

/**
 * Prints a line per declared machine, from asking each one: how aett reached
 * it, its tailnet address, whether it runs the system fleet.ts would build,
 * and for a machine that runs VMs, whether each guest runs. A machine the
 * build leaves out says why. It builds from what the fleet records and
 * changes none of it.
 */
export const status = Effect.fn("status")(function* (root: string) {
	const engine = yield* Engine;
	const ssh = yield* Ssh;
	const path = yield* Path.Path;
	const knownHosts = path.join(root, "state", "known_hosts");
	const { build, fleet, state, pins } = yield* emitAsIs(root);
	const width = Math.max(...fleet.machines.map(({ name }) => name.length));

	// A bare-metal machine's ways in: <name>.local first, the tailnet second.
	const metal = (name: string): ReadonlyArray<Way> => [
		{
			label: `${name}.local`,
			connect: ssh.machine(name, { name: `${name}.local`, port: 22 }, knownHosts),
		},
		...Option.toArray(
			Option.map(tailnetHost(state, name), (host) => ({
				label: "the tailnet",
				connect: ssh.machine(name, host, knownHosts),
			})),
		),
	];

	// A guest's ways in: the tailnet first, through its host second.
	const guest = (name: string, host: string): ReadonlyArray<Way> => [
		...Option.toArray(
			Option.map(tailnetHost(state, name), (tailnet) => ({
				label: "the tailnet",
				connect: ssh.machine(name, tailnet, knownHosts),
			})),
		),
		{
			label: `through ${host}`,
			connect: reach(metal(host)).pipe(
				Effect.flatMap(Effect.fromOption),
				Effect.flatMap(({ connection }) =>
					ssh.guest(name, state.machines.get(name)?.address ?? "", knownHosts, connection),
				),
			),
		},
	];

	// The guests that state places on `host` or fleet.ts declares there.
	const guestsOn = (host: string) => [
		...new Set([
			...guestsOf(fleet, host),
			...[...state.machines].flatMap(([name, record]) => (record.host === host ? [name] : [])),
		]),
	];

	const describe = (name: string) =>
		Effect.gen(function* () {
			if (!build.machines.includes(name)) return notBuilt(fleet, state, name);

			const machine = Option.fromUndefinedOr(
				fleet.machines.find((declared) => declared.name === name),
			);

			const host = Option.flatMap(machine, ({ vm }) => vm);

			const reached = yield* reach(
				Option.match(host, { onNone: () => metal(name), onSome: (vm) => guest(name, vm.host) }),
			);

			if (Option.isNone(reached)) return "unreachable";

			const { label, connection } = reached.value;
			const running = yield* engine.currentSystem(connection);
			const tailnet = (yield* connection.run("tailscale ip -4 2>/dev/null || true")).trim();

			// What apply would add to this machine's system that the build leaves out: a release without
			// a fitting pin, its own or a guest's, since a host's system holds its guests', and a guest
			// apply has yet to give an address. Comparing would then say nothing.
			const included = fleet.machines.filter(
				({ name: other, vm }) => other === name || Option.exists(vm, ({ host: on }) => on === name),
			);

			const unpinned = included
				.flatMap(({ releases }) => releases)
				.filter((release) =>
					Option.match(Option.fromUndefinedOr(pins.releases[release.github]), {
						onNone: () => true,
						onSome: (pin) => !pinFits(pin, release),
					}),
				);

			const unplaced = included.filter(
				({ name: other, vm, unsupported }) =>
					Option.isSome(vm) &&
					unsupported.length === 0 &&
					state.machines.get(other)?.address === undefined,
			);

			const pending = [
				...unpinned.map(({ bin }) => `${bin} isn't pinned yet`),
				...unplaced.map(({ name: vm }) => `${vm} has no address yet`),
			];

			// A declaration that doesn't evaluate still leaves what the machine said.
			const comparison =
				pending.length > 0
					? `${pending.join(", ")}; apply does that`
					: yield* engine.systemPath(build, name).pipe(
							Effect.map((expected) =>
								running === expected ? "runs fleet.ts" : "differs from fleet.ts",
							),
							Effect.catchTag("EngineError", () =>
								Effect.succeed("fleet.ts doesn't evaluate for it"),
							),
						);

			const guests = yield* Effect.forEach(guestsOn(name), (on) =>
				Effect.map(engine.guestState(connection, on), (unit) => `${on} ${unit}`),
			);

			return [
				`reached at ${label}`,
				tailnet === "" ? "not on the tailnet" : `tailnet ${tailnet.split("\n")[0]}`,
				comparison,
				...(guests.length > 0 ? [`guests: ${guests.join(", ")}`] : []),
			].join(" · ");
		}).pipe(
			Effect.scoped,
			// One machine that fails halfway leaves its line and the others.
			Effect.catch((error) => Effect.succeed(`failed: ${error.message}`)),
		);

	yield* Effect.forEach(fleet.machines, ({ name }) =>
		describe(name).pipe(Effect.flatMap((text) => Console.log(`${name.padEnd(width)}  ${text}`))),
	);
});
