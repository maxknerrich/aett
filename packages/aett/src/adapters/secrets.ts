import {
	Config,
	Console,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	type PlatformError,
	Redacted,
	Schema,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Engine, type EngineError } from "../engine/engine.ts";

export class SecretsError extends Schema.TaggedError<SecretsError>()("SecretsError", {
	message: Schema.String,
}) {}

/** Secrets in the fleet repository: files encrypted with the pinned sops to age keys. */
export class Secrets extends Context.Service<
	Secrets,
	{
		/**
		 * Returns the plaintext of the secret `file`, a path under the fleet
		 * `root`. A secret that does not exist yet comes from `produce` and is
		 * stored encrypted to `recipient`, an age public key. Decrypting takes
		 * the private key from SOPS_AGE_KEY, else from what SOPS_AGE_KEY_CMD prints.
		 */
		readonly ensure: <E, R>(
			root: string,
			file: string,
			recipient: string,
			produce: Effect.Effect<string, E, R>,
		) => Effect.Effect<string, E | SecretsError | EngineError | PlatformError.PlatformError, R>;
	}
>()("aett/adapters/Secrets") {
	static readonly layer = Layer.effect(
		Secrets,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const engine = yield* Engine;

			// Runs `command` and collects what it prints to the pipes it was given and its exit code.
			const run = Effect.fnUntraced(function* (command: ChildProcess.Command) {
				const handle = yield* spawner.spawn(command);

				const [stdout, stderr, exitCode] = yield* Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr)),
						handle.exitCode,
					],
					{ concurrency: "unbounded" },
				);

				return { stdout, stderr: stderr.trim(), exitCode };
			}, Effect.scoped);

			// Runs the pinned sops with only the given environment and without a .sops.yaml, so aett's
			// arguments alone decide how a secret is encrypted and SOPS_AGE_KEY alone decrypts it.
			const sops = Effect.fnUntraced(function* (
				args: ReadonlyArray<string>,
				options: { readonly env?: Record<string, string>; readonly stdin?: string },
			) {
				return yield* run(
					ChildProcess.make(
						path.join(yield* engine.tools, "sops"),
						["--config", "/dev/null", ...args],
						{
							env: options.env ?? {},
							extendEnv: false,
							stdin:
								options.stdin === undefined
									? "ignore"
									: Stream.make(new TextEncoder().encode(options.stdin)),
						},
					),
				);
			});

			// Runs SOPS_AGE_KEY_CMD in a shell with the operator's environment and terminal, so a
			// password manager can ask to be unlocked, and takes what it prints as the private key.
			const keyFromCommand = Effect.fnUntraced(function* (command: string) {
				const result = yield* run(
					ChildProcess.make("/bin/sh", ["-c", command], { stdin: "inherit", stderr: "inherit" }),
				);

				if (result.exitCode !== 0) {
					return yield* new SecretsError({
						message: `SOPS_AGE_KEY_CMD exited with ${result.exitCode}: ${command}`,
					});
				}

				return Redacted.make(result.stdout);
			});

			const keyVariable = yield* Config.option(Config.Redacted("SOPS_AGE_KEY")).pipe(Effect.orDie);
			const keyCommand = yield* Config.option(Config.String("SOPS_AGE_KEY_CMD")).pipe(Effect.orDie);

			// The operator's private age key: SOPS_AGE_KEY, else what SOPS_AGE_KEY_CMD prints. The
			// command runs only once a secret needs decrypting, and at most once per run.
			const ageKey = yield* Effect.cached(
				Option.match(keyVariable, {
					onSome: Effect.succeedSome,
					onNone: () => Effect.transposeOption(Option.map(keyCommand, keyFromCommand)),
				}),
			);

			const decrypt = Effect.fn("Secrets.decrypt")(function* (root: string, file: string) {
				const key = yield* Effect.flatMap(ageKey, (found) =>
					Effect.fromOption(
						found,
						() =>
							new SecretsError({
								message: `${file} is encrypted. Set SOPS_AGE_KEY to your private age key (AGE-SECRET-KEY-1…), which aett create showed, or SOPS_AGE_KEY_CMD to a command that prints it.`,
							}),
					),
				);

				const result = yield* sops(
					["decrypt", "--input-type", "json", "--output-type", "binary", path.join(root, file)],
					{ env: { SOPS_AGE_KEY: Redacted.value(key) } },
				);

				// sops exits with 128 when none of its keys opens the file.
				if (result.exitCode === 128) {
					return yield* new SecretsError({
						message: `The key from ${Option.isSome(keyVariable) ? "SOPS_AGE_KEY" : "SOPS_AGE_KEY_CMD"} cannot decrypt ${file}. It must be your private age key, which aett create showed.`,
					});
				}

				if (result.exitCode !== 0) {
					return yield* new SecretsError({
						message: `sops could not decrypt ${file}:\n${result.stderr}`,
					});
				}

				return result.stdout;
			});

			const encrypt = Effect.fn("Secrets.encrypt")(function* (
				root: string,
				file: string,
				recipient: string,
				plaintext: string,
			) {
				// sops reads stdin when no file is given and takes the file name for its formats alone.
				const result = yield* sops(
					[
						"encrypt",
						"--age",
						recipient,
						"--input-type",
						"binary",
						"--output-type",
						"json",
						"--filename-override",
						file,
					],
					{ stdin: plaintext },
				);

				if (result.exitCode !== 0) {
					return yield* new SecretsError({
						message: `sops could not encrypt ${file}:\n${result.stderr}`,
					});
				}

				yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
				yield* fs.writeFileString(path.join(root, file), result.stdout);
				yield* Console.log(`Wrote ${file}, encrypted to ${recipient}`);

				return plaintext;
			});

			const ensure = <E, R>(
				root: string,
				file: string,
				recipient: string,
				produce: Effect.Effect<string, E, R>,
			) =>
				Effect.flatMap(fs.exists(path.join(root, file)), (exists) =>
					exists
						? decrypt(root, file)
						: Effect.flatMap(produce, (plaintext) => encrypt(root, file, recipient, plaintext)),
				);

			return Secrets.of({ ensure });
		}),
	);
}
