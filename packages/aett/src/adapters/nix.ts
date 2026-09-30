import { pathToFileURL } from "node:url";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Connection } from "./ssh.ts";

export class NixError extends Schema.TaggedError<NixError>()("NixError", {
	message: Schema.String,
}) {}

// A local directory as a flake reference; nix parses it as a URL, so spaces and the like are percent-encoded.
const flakeAt = (directory: string) => `path:${pathToFileURL(directory).pathname}`;

// What `nix flake archive --json` prints; `path` is the flake's own store path.
const ArchiveOutput = Schema.fromJsonString(Schema.Struct({ path: Schema.String }));

/** aett's Nix engine: the pinned flake sources, the tools built from them and machine evaluation. */
export class Nix extends Context.Service<
	Nix,
	{
		/** The package's nix/ directory: flake, lock and NixOS modules. */
		readonly source: string;
		/** Store path of the controller tools; its bin/ holds ssh-add and friends. Built once per run. */
		readonly tools: Effect.Effect<string, NixError>;
		/** Evaluates one machine of a compiled build and returns its system derivation path. */
		readonly evalDrv: (build: string, name: string) => Effect.Effect<string, NixError>;
		/** Copies a compiled build and its inputs into the store behind `connection`; returns the build's store path there. */
		readonly archive: (build: string, connection: Connection) => Effect.Effect<string, NixError>;
	}
>()("aett/adapters/Nix") {
	/** Runs the nix CLI; `source` is the package's nix/ directory. */
	static readonly layer = (source: string) =>
		Layer.effect(
			Nix,
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

				// Returns trimmed stdout, or fails with nix's stderr. `env` extends aett's environment.
				const run = Effect.fn("Nix.run")(
					function* (args: ReadonlyArray<string>, env: Connection["nixEnv"] = {}) {
						const handle = yield* spawner.spawn(
							ChildProcess.make(
								"nix",
								["--extra-experimental-features", "nix-command flakes", ...args],
								{ stdin: "ignore", env, extendEnv: true },
							),
						);

						const [stdout, stderr, exitCode] = yield* Effect.all(
							[
								Stream.mkString(Stream.decodeText(handle.stdout)),
								Stream.mkString(Stream.decodeText(handle.stderr)),
								handle.exitCode,
							],
							{ concurrency: "unbounded" },
						);

						if (exitCode !== 0) {
							return yield* new NixError({
								message: `nix ${args.join(" ")} failed:\n${stderr.trim()}`,
							});
						}

						return stdout.trim();
					},
					Effect.scoped,
					Effect.catchTag("PlatformError", (error) =>
						Effect.fail(
							new NixError({ message: `Could not run nix, which aett needs: ${error.message}` }),
						),
					),
				);

				const tools = yield* Effect.cached(
					run(["build", "--no-link", "--print-out-paths", `${flakeAt(source)}#tools`]),
				);

				const evalDrv = Effect.fn("Nix.evalDrv")(function* (build: string, name: string) {
					return yield* run([
						"eval",
						"--raw",
						`${flakeAt(build)}#nixosConfigurations.${name}.config.system.build.toplevel.drvPath`,
					]);
				});

				const archive = Effect.fn("Nix.archive")(function* (build: string, connection: Connection) {
					const output = yield* run(
						["flake", "archive", "--json", "--to", connection.store, flakeAt(build)],
						connection.nixEnv,
					);

					return yield* Schema.decodeUnknownEffect(ArchiveOutput)(output).pipe(
						Effect.map(({ path }) => path),
						Effect.catchTag("SchemaError", (error) =>
							Effect.fail(
								new NixError({
									message: `nix flake archive printed unexpected output: ${error.message}`,
								}),
							),
						),
					);
				});

				return Nix.of({ source, tools, evalDrv, archive });
			}),
		);
}
