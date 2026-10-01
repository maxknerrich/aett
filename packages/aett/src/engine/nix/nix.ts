import { pathToFileURL } from "node:url";
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type Connection, shellQuote } from "../../adapters/ssh.ts";
import type { Fleet } from "../../domain/fleet.ts";
import type { State } from "../../domain/state.ts";
import { type Build, Engine, EngineError, type InstallSecrets } from "../engine.ts";
import { fleetJson } from "./fleet-json.ts";

// A local directory as a flake reference; nix parses it as a URL, so spaces and the like are percent-encoded.
const flakeAt = (directory: string) => `path:${pathToFileURL(directory).pathname}`;

// What `nix flake archive --json` prints; `path` is the flake's own store path.
const ArchiveOutput = Schema.fromJsonString(Schema.Struct({ path: Schema.String }));

// What `nix build --print-out-paths` prints for the system alone: its store path.
const SystemOutput = Schema.Tuple([Schema.String]);

// What it prints for an install: the system, its disk script and its install script, in that order.
const InstallOutputs = Schema.Tuple([Schema.String, Schema.String, Schema.String]);

// disk.nix's passwordFile, from which disko reads an encrypted disk's passphrase while it formats.
const passphraseFile = "/tmp/aett-luks-passphrase";

// Builds outputs of the machine's configuration on the target, streaming the log, and decodes their store paths.
const buildOn = <A>(
	target: Connection,
	source: string,
	name: string,
	outputs: ReadonlyArray<string>,
	paths: Schema.Decoder<A>,
) =>
	target
		.stream(
			`nix build --no-link --print-out-paths ${outputs
				.map((output) =>
					shellQuote(`${source}#nixosConfigurations.${name}.config.system.build.${output}`),
				)
				.join(" ")}`,
		)
		.pipe(
			Effect.flatMap((printed) =>
				Schema.decodeUnknownEffect(paths)(printed.trim().split("\n")).pipe(
					Effect.catchTag("SchemaError", () =>
						Effect.fail(
							new EngineError({
								message: `nix build printed unexpected store paths:\n${printed}`,
							}),
						),
					),
				),
			),
		);

const currentSystem = (target: Connection) =>
	target.run("readlink -f /run/current-system").pipe(Effect.map((system) => system.trim()));

const changes = (target: Connection, system: string) =>
	target
		.run(`nix store diff-closures /run/current-system ${shellQuote(system)}`)
		.pipe(Effect.map((text) => text.trim()));

// nixos-rebuild's invocation: a transient unit finishes the switch even if the connection drops.
// Its output goes to stderr, which streams to the terminal.
const activate = Effect.fn("NixEngine.activate")(function* (target: Connection, system: string) {
	yield* target.run(`nix-env -p /nix/var/nix/profiles/system --set ${shellQuote(system)}`);
	yield* target.stream(
		[
			"systemd-run -E LOCALE_ARCHIVE -E NIXOS_INSTALL_BOOTLOADER --collect --no-ask-password",
			"--pipe --quiet --service-type=exec --unit=aett-switch-to-configuration --wait",
			shellQuote(`${system}/bin/switch-to-configuration`),
			"switch >&2",
		].join(" "),
	);
});

// Runs `format` with the passphrase, if there is one, in passphraseFile on the target.
// The file is removed afterwards, also when writing it or formatting fails.
const withPassphraseFile = <A, E>(
	target: Connection,
	passphrase: Option.Option<string>,
	format: Effect.Effect<A, E>,
) =>
	Option.match(passphrase, {
		onNone: () => format,
		onSome: (value) =>
			target
				.run(`umask 077 && cat > ${passphraseFile}`, value)
				.pipe(
					Effect.andThen(format),
					Effect.ensuring(Effect.ignore(target.run(`rm -f ${passphraseFile}`))),
				),
	});

/**
 * The Nix engine. `flake` is the directory holding aett's flake, its lock and
 * the NixOS modules; every build starts as a copy of it with fleet.json and the
 * machines' facts added.
 */
export const nixEngine = (flake: string) =>
	Layer.effect(
		Engine,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const inheritedPath = yield* Config.String("PATH").pipe(Config.withDefault(""), Effect.orDie);

			// Runs the nix CLI and returns its trimmed stdout, or fails with its stderr. `env` extends aett's environment.
			const nix = Effect.fn("NixEngine.nix")(
				function* (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) {
					const handle = yield* spawner.spawn(
						ChildProcess.make(
							"nix",
							["--extra-experimental-features", "nix-command flakes", ...args],
							{
								stdin: "ignore",
								env,
								extendEnv: true,
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
						return yield* new EngineError({
							message: `nix ${args.join(" ")} failed:\n${stderr.trim()}`,
						});
					}

					return stdout.trim();
				},
				Effect.scoped,
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(
						new EngineError({ message: `Could not run nix, which aett needs: ${error.message}` }),
					),
				),
			);

			const tools = yield* Effect.cached(
				nix(["build", "--no-link", "--print-out-paths", `${flakeAt(flake)}#tools`]).pipe(
					Effect.map((out) => path.join(out, "bin")),
				),
			);

			const emit = Effect.fn("NixEngine.emit")(function* (
				root: string,
				fleet: Fleet,
				state: State,
			) {
				const emitted = fleetJson(fleet, state);
				const directory = path.join(root, ".aett", "build");

				yield* fs.remove(directory, { recursive: true, force: true });
				yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
				yield* fs.copy(flake, directory);

				// Copies out of the Nix store are read-only, and the next emit has to delete them.
				const entries = yield* fs.readDirectory(directory, { recursive: true });

				yield* Effect.forEach(
					[directory, ...entries.map((entry) => path.join(directory, entry))],
					(entry) =>
						fs.stat(entry).pipe(Effect.flatMap(({ mode }) => fs.chmod(entry, mode | 0o200))),
				);

				yield* fs.writeFileString(
					path.join(directory, "fleet.json"),
					`${JSON.stringify(emitted, null, "\t")}\n`,
				);

				const machines = Object.keys(emitted.machines);

				// Evaluation is pure, so the flake reads the facts from its own directory.
				yield* Effect.forEach(machines, (name) =>
					fs
						.makeDirectory(path.join(directory, "state", name), { recursive: true })
						.pipe(
							Effect.andThen(
								fs.copyFile(
									path.join(root, "state", name, "facter.json"),
									path.join(directory, "state", name, "facter.json"),
								),
							),
						),
				);

				return { directory, machines } satisfies Build;
			});

			const evaluate = Effect.fn("NixEngine.evaluate")(function* (build: Build, name: string) {
				return yield* nix([
					"eval",
					"--raw",
					`${flakeAt(build.directory)}#nixosConfigurations.${name}.config.system.build.toplevel.drvPath`,
				]);
			});

			// Copies the build and its locked inputs into the target's store; returns the build's store path there.
			// nix reaches the target through its master connection: the pinned ssh first on PATH and the
			// connection's options in NIX_SSHOPTS, which nix splits like a shell. With more than one
			// connection nix would open its own master, which could not log in to an installer.
			const ship = Effect.fn("NixEngine.ship")(function* (build: Build, target: Connection) {
				yield* Console.log("Copying aett's flake and its inputs…");

				const output = yield* nix(
					[
						"flake",
						"archive",
						"--json",
						"--to",
						`ssh-ng://${target.destination}?max-connections=1`,
						flakeAt(build.directory),
					],
					{
						PATH: `${yield* tools}:${inheritedPath}`,
						NIX_SSHOPTS: target.sshOptions.map(shellQuote).join(" "),
					},
				);

				return yield* Schema.decodeUnknownEffect(ArchiveOutput)(output).pipe(
					Effect.map(({ path: stored }) => stored),
					Effect.catchTag("SchemaError", (error) =>
						Effect.fail(
							new EngineError({
								message: `nix flake archive printed unexpected output: ${error.message}`,
							}),
						),
					),
				);
			});

			const buildSystem = Effect.fn("NixEngine.buildSystem")(function* (
				build: Build,
				name: string,
				target: Connection,
			) {
				const source = yield* ship(build, target);

				yield* Console.log("Building the system…");

				const [system] = yield* buildOn(target, source, name, ["toplevel"], SystemOutput);

				return system;
			});

			const install = Effect.fn("NixEngine.install")(function* (
				build: Build,
				name: string,
				target: Connection,
				secrets: InstallSecrets,
			) {
				const source = yield* ship(build, target);

				yield* Console.log(`Building ${name} on the installer…`);

				const [toplevel, formatDisk, prepare] = yield* buildOn(
					target,
					source,
					name,
					["toplevel", "destroyFormatMount", "aettInstall"],
					InstallOutputs,
				);

				yield* Console.log("Erasing the disk…");
				yield* withPassphraseFile(
					target,
					secrets.passphrase,
					target.run(
						`${shellQuote(`${formatDisk}/bin/disko-destroy-format-mount`)} --yes-wipe-all-disks`,
					),
				);
				yield* target.run(`${shellQuote(prepare)} /mnt`);
				// Where the NixOS module points sshd. sshd ignores a private key that others can read.
				yield* target.run(
					"mkdir -p /mnt/persist/etc/ssh && umask 077 && cat > /mnt/persist/etc/ssh/ssh_host_ed25519_key",
					secrets.hostKey.privateKey,
				);
				yield* target.run(
					"umask 022 && cat > /mnt/persist/etc/ssh/ssh_host_ed25519_key.pub",
					`${secrets.hostKey.publicKey}\n`,
				);
				yield* Console.log("Installing…");
				yield* target.run(
					`nixos-install --root /mnt --system ${shellQuote(toplevel)} --no-root-passwd --no-channel-copy`,
				);
			});

			return Engine.of({
				tools,
				emit,
				evaluate,
				buildSystem,
				currentSystem,
				changes,
				activate,
				install,
			});
		}),
	);
