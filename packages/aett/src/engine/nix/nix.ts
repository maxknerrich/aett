import { pathToFileURL } from "node:url";
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type Connection, shellQuote } from "../../adapters/ssh.ts";
import type { Fleet } from "../../domain/fleet.ts";
import type { State } from "../../domain/state.ts";
import { type Build, Engine, EngineError, type HostKey, type InstallSecrets } from "../engine.ts";
import { FacterReport, installFacts } from "./facter.ts";
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

// What it prints for a guest: its system and its runner.
const GuestOutputs = Schema.Tuple([Schema.String, Schema.String]);

const GuestStateOutput = Schema.Literals(["absent", "stopped", "running"]);

// Builds attributes of the machine's configuration, such as system.build.toplevel, on the target,
// streaming the log, and decodes their store paths.
const buildOn = <A>(
	target: Connection,
	source: string,
	name: string,
	attributes: ReadonlyArray<string>,
	paths: Schema.Decoder<A>,
) =>
	target
		.stream(
			`nix build --no-link --print-out-paths ${attributes
				.map((attribute) => shellQuote(`${source}#nixosConfigurations.${name}.config.${attribute}`))
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

const changes = (target: Connection, from: string, to: string) =>
	target
		.run(`nix store diff-closures ${shellQuote(from)} ${shellQuote(to)}`)
		.pipe(Effect.map((text) => text.trim()));

// nixos-rebuild's invocation: a transient unit finishes the switch even if the connection drops.
// Its output goes to stderr, which streams to the terminal.
const switchTo = (target: Connection, system: string) =>
	target.stream(
		[
			"systemd-run -E LOCALE_ARCHIVE -E NIXOS_INSTALL_BOOTLOADER --collect --no-ask-password",
			"--pipe --quiet --service-type=exec --unit=aett-switch-to-configuration --wait",
			shellQuote(`${system}/bin/switch-to-configuration`),
			"switch >&2",
		].join(" "),
	);

const activate = Effect.fn("NixEngine.activate")(function* (target: Connection, system: string) {
	yield* target.run(`nix-env -p /nix/var/nix/profiles/system --set ${shellQuote(system)}`);
	yield* switchTo(target, system);
});

// A guest boots whatever its host's runner says, and its store is the host's, read-only, so a
// switch only activates the new system; it records no profile.
const switchGuest = (guest: Connection, system: string) =>
	switchTo(guest, system).pipe(Effect.asVoid);

// guest.nix links what a guest boots with into its system as aett-boot. A switch can't change any of it.
const needsRestart = (guest: Connection, system: string) =>
	guest
		.run(
			`booted=$(readlink -e /run/booted-system/aett-boot || true); [ -n "$booted" ] && [ "$booted" = "$(readlink -e ${shellQuote(`${system}/aett-boot`)})" ] && echo same || echo changed`,
		)
		.pipe(Effect.map((output) => output.trim() !== "same"));

// microvm.nix's per-guest directory on its host, where vm-host.nix sets its stateDir.
const guestDirectory = (guest: string) => `/persist/microvms/${guest}`;

// Where vm-host.nix links each guest's runners as GC roots, a directory per guest.
const gcRoots = "/nix/var/nix/gcroots/aett-guests";

const guestUnit = (guest: string) => shellQuote(`microvm@${guest}.service`);

const controlGuest = (host: Connection, guest: string, action: "start" | "restart" | "stop") =>
	host.run(`systemctl ${action} ${guestUnit(guest)}`).pipe(Effect.asVoid);

const removeGuest = (host: Connection, guest: string) =>
	host
		.run(`rm -rf -- ${shellQuote(guestDirectory(guest))} ${shellQuote(`${gcRoots}/${guest}`)}`)
		.pipe(Effect.asVoid);

// A unit that is active or on its way up or down counts as running. Otherwise the guest is
// installed once its host links a runner as `current`.
const guestState = (host: Connection, guest: string) =>
	host
		.run(
			`case "$(systemctl is-active ${guestUnit(guest)})" in inactive|failed) if [ -e ${shellQuote(`${guestDirectory(guest)}/current`)} ]; then echo stopped; else echo absent; fi ;; *) echo running ;; esac`,
		)
		.pipe(
			Effect.flatMap((output) => Schema.decodeUnknownEffect(GuestStateOutput)(output.trim())),
			Effect.catchTag("SchemaError", () =>
				Effect.fail(new EngineError({ message: `Could not tell whether ${guest} runs.` })),
			),
		);

// Writes a host key pair into `directory` on the target, the private half readable by root only.
// sshd ignores a private key that others can read.
const writeHostKey = Effect.fn("NixEngine.writeHostKey")(function* (
	target: Connection,
	directory: string,
	hostKey: HostKey,
) {
	const file = `${directory}/ssh_host_ed25519_key`;

	yield* target.run(
		`install -d -m 0700 -o root -g root ${shellQuote(directory)} && umask 077 && cat > ${shellQuote(file)}`,
		hostKey.privateKey,
	);
	yield* target.run(`umask 022 && cat > ${shellQuote(`${file}.pub`)}`, `${hostKey.publicKey}\n`);
});

// Where a host keeps a guest's host key, which guest.nix shares into the guest at /persist/etc/ssh.
const guestKeyDirectory = (root: string, guest: string) =>
	`${root}${guestDirectory(guest)}/identity`;

const placeGuestKey = (host: Connection, guest: string, hostKey: HostKey) =>
	writeHostKey(host, guestKeyDirectory("", guest), hostKey);

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

			// The report is saved exactly as nixos-facter printed it, once it proves readable; emit copies it into the build.
			const discover = Effect.fn("NixEngine.discover")(function* (
				root: string,
				name: string,
				target: Connection,
			) {
				yield* Console.log("Running nixos-facter on the installer…");

				const report = yield* target.run("nixos-facter");

				const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FacterReport))(
					report,
				).pipe(
					Effect.catchTag("SchemaError", (error) =>
						Effect.fail(
							new EngineError({
								message: `nixos-facter printed a report aett cannot read: ${error.message}`,
							}),
						),
					),
				);

				yield* fs.makeDirectory(path.join(root, "state", name), { recursive: true });
				yield* fs.writeFileString(path.join(root, "state", name, "facter.json"), report);
				yield* Console.log(`Wrote state/${name}/facter.json`);

				return installFacts(decoded);
			});

			const discovered = (root: string, name: string) =>
				fs.exists(path.join(root, "state", name, "facter.json"));

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

				// Evaluation is pure, so the flake reads the facts from its own directory. VMs have none;
				// their host's facts say what they run on.
				const reported = machines.filter((name) => state.machines.get(name)?.facts === true);

				yield* Effect.forEach(reported, (name) =>
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

				const [system] = yield* buildOn(
					target,
					source,
					name,
					["system.build.toplevel"],
					SystemOutput,
				);

				return system;
			});

			// The guest's runner becomes `current`, which its unit starts; vm-host.nix makes it and
			// `booted` GC roots. The host's own switch links the same runner there when it lists the guest.
			const buildGuest = Effect.fn("NixEngine.buildGuest")(function* (
				build: Build,
				guest: string,
				host: Connection,
			) {
				const source = yield* ship(build, host);

				yield* Console.log(`Building ${guest} on its host…`);

				const [system, runner] = yield* buildOn(
					host,
					source,
					guest,
					["system.build.toplevel", "microvm.declaredRunner"],
					GuestOutputs,
				);

				yield* host.run(
					`ln -sfn ${shellQuote(runner)} ${shellQuote(`${guestDirectory(guest)}/current`)}`,
				);

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
					["system.build.toplevel", "system.build.destroyFormatMount", "system.build.aettInstall"],
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
				// Where metal.nix points sshd.
				yield* writeHostKey(target, "/mnt/persist/etc/ssh", secrets.hostKey);
				yield* Effect.forEach(secrets.guests, ([guest, hostKey]) =>
					writeHostKey(target, guestKeyDirectory("/mnt", guest), hostKey),
				);
				yield* Console.log("Installing…");
				yield* target.run(
					`nixos-install --root /mnt --system ${shellQuote(toplevel)} --no-root-passwd --no-channel-copy`,
				);
			});

			return Engine.of({
				tools,
				discover,
				discovered,
				emit,
				evaluate,
				buildSystem,
				currentSystem,
				changes,
				activate,
				guestState,
				buildGuest,
				needsRestart,
				switchGuest,
				controlGuest,
				removeGuest,
				placeGuestKey,
				install,
			});
		}),
	);
