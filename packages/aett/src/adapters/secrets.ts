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

// The recipients sops records in an encrypted file, readable without the key.
const SopsRecipients = Schema.Struct({
	sops: Schema.Struct({
		age: Schema.optionalKey(Schema.Array(Schema.Struct({ recipient: Schema.String }))),
	}),
});

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
		 * stored encrypted to `recipients`, age public keys. Decrypting takes
		 * the private key from SOPS_AGE_KEY, else from what SOPS_AGE_KEY_CMD prints.
		 */
		readonly ensure: <E, R>(
			root: string,
			file: string,
			recipients: ReadonlyArray<string>,
			produce: Effect.Effect<string, E, R>,
		) => Effect.Effect<string, E | SecretsError | EngineError | PlatformError.PlatformError, R>;
		/** Stores `plaintext` as the secret `file`, encrypted to `recipients`, replacing what it held. */
		readonly write: (
			root: string,
			file: string,
			recipients: ReadonlyArray<string>,
			plaintext: string,
		) => Effect.Effect<void, SecretsError | EngineError | PlatformError.PlatformError>;
		/** The age public keys the secret `file` is encrypted to, read without decrypting it. */
		readonly recipients: (
			root: string,
			file: string,
		) => Effect.Effect<ReadonlySet<string>, SecretsError | PlatformError.PlatformError>;
		/**
		 * Encrypts the secret `file` to exactly `recipients`, decrypting it
		 * first when they differ from the ones it has. Returns whether it changed.
		 */
		readonly share: (
			root: string,
			file: string,
			recipients: ReadonlyArray<string>,
		) => Effect.Effect<boolean, SecretsError | EngineError | PlatformError.PlatformError>;
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
			// It stays in aett's session; a detached one has no /dev/tty to prompt on.
			const keyFromCommand = Effect.fnUntraced(function* (command: string) {
				const result = yield* run(
					ChildProcess.make("/bin/sh", ["-c", command], {
						stdin: "inherit",
						stderr: "inherit",
						detached: false,
					}),
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
								message: `${file} is encrypted. Set SOPS_AGE_KEY to the private half of your age key in state/operator.json (AGE-SECRET-KEY-1…), or SOPS_AGE_KEY_CMD to a command that prints it.`,
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
						message: `The key from ${Option.isSome(keyVariable) ? "SOPS_AGE_KEY" : "SOPS_AGE_KEY_CMD"} cannot decrypt ${file}. It must be the private half of an age key in state/operator.json, and one that was there when ${file} was written.`,
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
				recipients: ReadonlyArray<string>,
				plaintext: string,
			) {
				// sops reads stdin when no file is given and takes the file name for its formats alone.
				const result = yield* sops(
					[
						"encrypt",
						"--age",
						recipients.join(","),
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
				yield* Console.log(`Wrote ${file}, encrypted to ${recipients.join(", ")}`);

				return plaintext;
			});

			const ensure = <E, R>(
				root: string,
				file: string,
				recipients: ReadonlyArray<string>,
				produce: Effect.Effect<string, E, R>,
			) =>
				Effect.flatMap(fs.exists(path.join(root, file)), (exists) =>
					exists
						? decrypt(root, file)
						: Effect.flatMap(produce, (plaintext) => encrypt(root, file, recipients, plaintext)),
				);

			const write = (
				root: string,
				file: string,
				recipients: ReadonlyArray<string>,
				plaintext: string,
			) => Effect.asVoid(encrypt(root, file, recipients, plaintext));

			const recipients = Effect.fn("Secrets.recipients")(function* (root: string, file: string) {
				const current = yield* fs.readFileString(path.join(root, file)).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SopsRecipients))),
					Effect.catchTag("SchemaError", () =>
						Effect.fail(new SecretsError({ message: `${file} is not a secret aett can read.` })),
					),
				);

				return new Set((current.sops.age ?? []).map(({ recipient }) => recipient));
			});

			const share = Effect.fn("Secrets.share")(function* (
				root: string,
				file: string,
				wanted: ReadonlyArray<string>,
			) {
				const had = yield* recipients(root, file);

				if (had.size === wanted.length && wanted.every((recipient) => had.has(recipient))) {
					return false;
				}

				yield* write(root, file, wanted, yield* decrypt(root, file));

				return true;
			});

			return Secrets.of({ ensure, write, recipients, share });
		}),
	);
}
