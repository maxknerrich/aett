import { createRequire } from "node:module";
import { Effect, FileSystem, Option, Path, Schema, Stdio } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { findFleet } from "../workflows/load.ts";

// The part of an aett package.json the hand-off reads: where its CLI is.
const AettManifest = Schema.fromJsonString(
	Schema.Struct({ bin: Schema.Struct({ aett: Schema.String }) }),
);

/**
 * The CLI of the aett that the surrounding fleet installed, when it is another
 * copy than the running one, whose package directory is `own`. A global aett
 * hands off to it, so a fleet always runs the aett version it pins. None
 * outside a fleet, or when the fleet has no aett installed.
 */
export const fleetAett = Effect.fn("fleetAett")(function* (own: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* findFleet(path.resolve());

	const manifest = Option.flatMap(root, (directory) =>
		Option.liftThrowable(() =>
			createRequire(path.join(directory, "package.json")).resolve("aett/package.json"),
		)(),
	);

	if (Option.isNone(manifest)) return Option.none<string>();

	const local = yield* fs.realPath(path.dirname(manifest.value));

	if (local === (yield* fs.realPath(own))) return Option.none<string>();

	// An aett too old or broken to say where its CLI is can't take over; this one runs instead.
	return yield* fs.readFileString(manifest.value).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(AettManifest)),
		Effect.map(({ bin }) => Option.some(path.join(local, bin.aett))),
		Effect.catchTag("SchemaError", () => Effect.succeed(Option.none<string>())),
	);
});

/** Runs the aett CLI at `cli` with this process's arguments and terminal, and exits with its code. */
export const handOff = Effect.fn("handOff")(function* (cli: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const args = yield* (yield* Stdio.Stdio).args;

	const exitCode = yield* spawner.exitCode(
		// On aett's terminal, which the fleet's copy needs for prompts and sudo.
		ChildProcess.make(process.execPath, [cli, ...args], {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			detached: false,
		}),
	);

	yield* Effect.sync(() => {
		process.exitCode = exitCode;
	});
});
