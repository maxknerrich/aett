import { Console, Effect, FileSystem, Path } from "effect";
import { Nix } from "../adapters/nix.ts";
import { fleetJson } from "../domain/emission.ts";
import { loadFleet, readState } from "./load.ts";

/**
 * Emits `<root>/.aett/build/`: aett's flake, fleet.json and the recorded facts
 * of every machine it lists. Returns the build's absolute path with the fleet,
 * state and fleet.json it was made from.
 */
export const emit = Effect.fn("emit")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const nix = yield* Nix;
	const fleet = yield* loadFleet(root);
	const state = yield* readState(root, fleet);
	const emitted = fleetJson(fleet, state);
	const build = path.join(root, ".aett", "build");

	yield* fs.remove(build, { recursive: true, force: true });
	yield* fs.makeDirectory(path.dirname(build), { recursive: true });
	yield* fs.copy(nix.source, build);

	// Copies out of the Nix store are read-only, and the next compile has to delete them.
	const entries = yield* fs.readDirectory(build, { recursive: true });

	yield* Effect.forEach([build, ...entries.map((entry) => path.join(build, entry))], (entry) =>
		fs.stat(entry).pipe(Effect.flatMap(({ mode }) => fs.chmod(entry, mode | 0o200))),
	);

	yield* fs.writeFileString(
		path.join(build, "fleet.json"),
		`${JSON.stringify(emitted, null, "\t")}\n`,
	);

	yield* Effect.forEach(Object.keys(emitted.machines), (name) =>
		fs
			.makeDirectory(path.join(build, "state", name), { recursive: true })
			.pipe(
				Effect.andThen(
					fs.copyFile(
						path.join(root, "state", name, "facter.json"),
						path.join(build, "state", name, "facter.json"),
					),
				),
			),
	);

	return { build, fleet, state, emitted };
});

/**
 * Emits the build, then evaluates the machines it lists and reports the rest
 * as not discovered or not installed yet.
 */
export const compile = Effect.fn("compile")(function* (root: string) {
	const path = yield* Path.Path;
	const nix = yield* Nix;
	const { build, fleet, state, emitted } = yield* emit(root);

	yield* Console.log(`Wrote ${path.relative(root, build)}/`);

	yield* Effect.forEach(fleet.machines, ({ name }) =>
		Object.hasOwn(emitted.machines, name)
			? nix.evalDrv(build, name).pipe(Effect.flatMap((drv) => Console.log(`${name}: ${drv}`)))
			: Console.log(
					`${name}: ${state.machines.get(name)?.facts === true ? "not installed yet" : "not discovered yet"}`,
				),
	);
});
