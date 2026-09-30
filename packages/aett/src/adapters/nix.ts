import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class NixError extends Schema.TaggedError<NixError>()("NixError", {
	message: Schema.String,
}) {}

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
	}
>()("aett/adapters/Nix") {
	/** Runs the nix CLI; `source` is the package's nix/ directory. */
	static readonly layer = (source: string) =>
		Layer.effect(
			Nix,
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

				// Returns trimmed stdout, or fails with nix's stderr.
				const run = Effect.fn("Nix.run")(
					function* (args: ReadonlyArray<string>) {
						const handle = yield* spawner.spawn(
							ChildProcess.make(
								"nix",
								["--extra-experimental-features", "nix-command flakes", ...args],
								{
									stdin: "ignore",
								},
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
					run(["build", "--no-link", "--print-out-paths", `path:${source}#tools`]),
				);

				const evalDrv = Effect.fn("Nix.evalDrv")(function* (build: string, name: string) {
					return yield* run([
						"eval",
						"--raw",
						`path:${build}#nixosConfigurations.${name}.config.system.build.toplevel.drvPath`,
					]);
				});

				return Nix.of({ source, tools, evalDrv });
			}),
		);
}
