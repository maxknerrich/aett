import { Console, Effect, FileSystem, Option, Path } from "effect";
import type { Fleet } from "../domain/fleet.ts";
import { allocate, sshConfig } from "../domain/network.ts";
import { mergeInputs, type Pins } from "../domain/pins.ts";
import type { MachineRecord, State } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";
import { ensureGuestKeys } from "./identity.ts";
import { FleetError, loadFleet, readState, updateRecord } from "./load.ts";
import { completePins, readPins } from "./pins.ts";
import { existingSecrets, shareSecrets } from "./secrets.ts";

/**
 * Loads the fleet and its state, records the guest addresses and host keys
 * state still lacks, encrypts the secrets machines read to the machines that
 * read them, completes the fleet's pins, and has the engine write the build
 * to `<root>/.aett/build/`. Returns the build with the fleet, state and pins
 * it was made from.
 */
export const emit = Effect.fn("emit")(function* (root: string) {
	const engine = yield* Engine;
	const path = yield* Path.Path;
	const fleet = yield* loadFleet(root);
	const recorded = yield* readState(root, fleet);

	const changes = yield* Effect.fromResult(allocate(fleet, recorded)).pipe(
		Effect.mapError((message) => new FleetError({ message })),
	);

	yield* Effect.forEach(changes, ([name, record]) => updateRecord(root, name, record));

	const state = changes.size === 0 ? recorded : yield* readState(root, fleet);

	yield* ensureGuestKeys(root, fleet, state.operator.ageKeys);
	yield* writeSshConfig(root, sshConfig(fleet, state, path.join(root, "state", "known_hosts")));
	const extras = yield* shareSecrets(root, fleet, state);
	const pins = yield* completePins(root, fleet, state);
	const build = yield* engine.emit(root, fleet, state, extras, pins);

	return { build, fleet, state, pins };
});

// Writes state/ssh_config when it changes, and removes it once no machine has the user.
const writeSshConfig = Effect.fn("writeSshConfig")(function* (root: string, content: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, "state", "ssh_config");
	const exists = yield* fs.exists(file);

	if (content === "") return yield* exists ? fs.remove(file) : Effect.void;

	if (exists && (yield* fs.readFileString(file)) === content) return yield* Effect.void;

	yield* fs.writeFileString(file, content);

	return yield* Console.log(
		"Wrote state/ssh_config. Include it from ~/.ssh/config to log in to the fleet's machines as yourself.",
	);
});

/**
 * Writes the build from fleet.ts and what the fleet records, recording
 * nothing: the addresses and forwards apply would hand out are taken in
 * memory, as are aett's tested revisions for inputs the pins lack, and no
 * key, secret or pin is made, asked for or changed. Machines that need one of
 * them are left out or built without it.
 */
export const emitAsIs = Effect.fn("emitAsIs")(function* (root: string) {
	const engine = yield* Engine;
	const fleet = yield* loadFleet(root);
	const recorded = yield* readState(root, fleet);

	const allocated = yield* Effect.fromResult(allocate(fleet, recorded)).pipe(
		Effect.mapError((message) => new FleetError({ message })),
	);

	const state: State = {
		operator: recorded.operator,
		machines: new Map([
			...recorded.machines,
			...[...allocated].map(
				([name, change]: readonly [string, typeof MachineRecord.Type]) =>
					[name, { facts: false, ...recorded.machines.get(name), ...change }] as const,
			),
		]),
	};

	const extras = yield* existingSecrets(root, fleet);
	const defaults = yield* engine.defaultInputs;

	// Inputs a newer aett added are pinned at its tested revisions, as apply would.
	const pins = Option.match(yield* readPins(root), {
		onNone: (): Pins => ({ inputs: defaults, releases: {}, packages: {} }),
		onSome: ({ inputs, releases, packages }): Pins => ({
			inputs: mergeInputs(inputs, defaults).lock,
			releases,
			packages,
		}),
	});

	const build = yield* engine.emit(root, fleet, state, extras, pins);

	return { build, fleet, state, pins };
});

/**
 * Emits the build, then evaluates the machines it covers and reports the rest
 * as not discovered or not installed yet.
 */
export const compile = Effect.fn("compile")(function* (root: string) {
	const path = yield* Path.Path;
	const engine = yield* Engine;
	const { build, fleet, state } = yield* emit(root);

	yield* Console.log(`Wrote ${path.relative(root, build.directory)}/`);

	yield* Effect.forEach(fleet.machines, ({ name }) =>
		build.machines.includes(name)
			? engine.evaluate(build, name).pipe(Effect.flatMap((drv) => Console.log(`${name}: ${drv}`)))
			: Console.log(`${name}: ${notBuilt(fleet, state, name)}`),
	);
});

/** Why the build leaves a machine out. */
export const notBuilt = (fleet: Fleet, state: State, name: string) => {
	const machine = fleet.machines.find((declared) => declared.name === name);
	const unsupported = machine?.unsupported ?? [];

	if (unsupported.length > 0) return `not supported yet: ${unsupported.join(", ")}`;

	const host = Option.flatMap(Option.fromUndefinedOr(machine), ({ vm }) => vm);

	if (Option.isSome(host)) return `runs on ${host.value.host}, which is not installed yet`;

	if (machine?.kind === "macos") return "not applied on it yet: run aett apply on the Mac";

	return state.machines.get(name)?.facts === true ? "not installed yet" : "not discovered yet";
};
