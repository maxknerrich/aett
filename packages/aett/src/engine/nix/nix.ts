import { pathToFileURL } from "node:url";
import {
	Config,
	Console,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Redacted,
	Schema,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type Connection, shellQuote } from "../../adapters/ssh.ts";
import type { Channel, Fleet } from "../../domain/fleet.ts";
import { Source } from "../../domain/packages.ts";
import { InputsLock, type Pins, Platform } from "../../domain/pins.ts";
import { machineSecrets } from "../../domain/secrets.ts";
import type { State } from "../../domain/state.ts";
import { joinedFrom } from "../../domain/tailnet.ts";
import {
	type Approve,
	type Build,
	Engine,
	EngineError,
	type HostKey,
	type Installed,
	type InstallSecrets,
} from "../engine.ts";
import { FacterReport, installFacts } from "./facter.ts";
import { pluginDirectory } from "../../adapters/assets.ts";
import { type Extras, fleetJson } from "./fleet-json.ts";
import { wpaSupplicant } from "./wifi.ts";

// A local directory as a flake reference; nix parses it as a URL, so spaces and the like are percent-encoded.
const flakeAt = (directory: string) => `path:${pathToFileURL(directory).pathname}`;

// What `nix flake archive --json` prints; `path` is the flake's own store path.
const ArchiveOutput = Schema.fromJsonString(Schema.Struct({ path: Schema.String }));

// What `nix store prefetch-file --json` prints; `hash` is the file's SRI hash.
const PrefetchOutput = Schema.fromJsonString(Schema.Struct({ hash: Schema.String }));

const Lock = Schema.fromJsonString(InputsLock);

// What flake.nix's lib.sources returns: each name's source, or null.
const Sources = Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Source)));

// The platform a nixos-facter report was made on.
const ReportedSystem = Schema.fromJsonString(Schema.Struct({ system: Platform }));

// What evaluating several machines' systems prints: each one's store path by name.
const SystemPaths = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

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
	// The switch installed the boot loader, which put the Wi-Fi networks into the initrd.
	yield* target.run(`rm -f ${wifiPending}`);
});

// A guest boots whatever its host's runner says, and its store is the host's, read-only, so a
// switch only activates the new system; it records no profile. Its host keeps the system it
// switched to as a GC root, which the guest's next start or restart drops again.
const switchGuest = Effect.fn("NixEngine.switchGuest")(function* (
	host: Connection,
	guest: Connection,
	name: string,
	system: string,
) {
	yield* switchTo(guest, system);
	yield* host.run(`ln -sfn ${shellQuote(system)} ${shellQuote(switchedRoot(name))}`);
});

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

// The GC root of the system a running guest was switched to in place.
const switchedRoot = (guest: string) => `${gcRoots}/${guest}/switched`;

const guestUnit = (guest: string) => shellQuote(`microvm@${guest}.service`);

// A guest that starts runs its runner's system, which its `current` and `booted` roots keep.
const controlGuest = (host: Connection, guest: string, action: "start" | "restart" | "stop") =>
	host
		.run(
			action === "stop"
				? `systemctl stop ${guestUnit(guest)}`
				: `systemctl ${action} ${guestUnit(guest)} && rm -f -- ${shellQuote(switchedRoot(guest))}`,
		)
		.pipe(Effect.asVoid);

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

// Where an installer keeps the tailnet identity the machine joined with until the install copies it.
const joinDirectory = "/run/aett-join";

// Where unlock.nix takes the initrd's sshd key and Wi-Fi networks from.
const unlockDirectory = "/persist/aett/unlock";

// How a node joins the tailnet: as `hostname`, with `flags` for tailscale up, through the system's
// tailscaled, or with `directory`, through one of its own in userspace that keeps the node's identity
// there and leaves the system's node alone. `bin` is where tailscale and tailscaled are, if not on PATH.
interface Joiner {
	readonly hostname: string;
	readonly flags: string;
	readonly bin: string;
	readonly directory: Option.Option<string>;
}

// The joining node's files: tailscale up's output and process, and its own tailscaled's socket and process.
const joinFiles = (joiner: Joiner) => `/run/aett-join-${joiner.hostname}`;

// The shell functions both halves of joining use: ts runs the CLI against the node's tailscaled,
// running says whether the node is on the tailnet, and stop ends a tailscaled of its own.
const joinHelpers = (joiner: Joiner) => {
	const files = joinFiles(joiner);
	const socket = Option.isSome(joiner.directory) ? ` --socket=${files}.sock` : "";

	return `files=${files}
ts() { ${joiner.bin}tailscale${socket} "$@"; }
running() { ts status --json --peers=false 2>/dev/null | grep -q '"BackendState": *"Running"'; }
stop() { [ -f "$files.daemon" ] || return 0; kill "$(cat "$files.daemon")" 2>/dev/null || true; for _ in $(seq 20); do kill -0 "$(cat "$files.daemon")" 2>/dev/null || break; sleep 0.5; done; rm -f "$files.daemon" "$files.sock"; }
`;
};

// Run as root: starts the node joining and prints the URL the operator approves it at, or nothing when
// it is on the tailnet already. tailscale up keeps waiting for the approval after this returns.
const startJoining = (joiner: Joiner) => `set -eu
${joinHelpers(joiner)}${Option.match(joiner.directory, {
	onNone: () => "",
	onSome: (directory) => `install -d -m 0700 ${shellQuote(directory)}
if [ ! -S "$files.sock" ]; then
  nohup ${joiner.bin}tailscaled --statedir=${shellQuote(directory)} --state=${shellQuote(`${directory}/tailscaled.state`)} --socket="$files.sock" --tun=userspace-networking --port=0 </dev/null >/dev/null 2>&1 &
  echo $! > "$files.daemon"
  for _ in $(seq 30); do [ -S "$files.sock" ] && break; sleep 1; done
fi
`,
})}if running; then exit 0; fi
nohup ${joiner.bin}tailscale${Option.isSome(joiner.directory) ? ' --socket="$files.sock"' : ""} up --reset --hostname=${shellQuote(joiner.hostname)} ${joiner.flags} --timeout=15m </dev/null >"$files.log" 2>&1 &
up=$!
echo "$up" > "$files.pid"
for _ in $(seq 60); do
  url=$(grep -o 'https://[^[:space:]]*' "$files.log" | head -n 1 || true)
  if [ -n "$url" ]; then echo "$url"; exit 0; fi
  kill -0 "$up" 2>/dev/null || break
  sleep 1
done
if wait "$up" && running; then exit 0; fi
cat "$files.log" >&2
stop
exit 1
`;

// Run as root after startJoining: waits up to 15 minutes for the approval, then prints the node's
// status and stops a tailscaled of its own, whose identity stays in its directory.
const finishJoining = (joiner: Joiner) => `set -eu
${joinHelpers(joiner)}for _ in $(seq 900); do
  if running; then
    ts status --json --peers=false | tr -d '\n'
    echo
    stop
    exit 0
  fi
  if [ -f "$files.pid" ] && ! kill -0 "$(cat "$files.pid")" 2>/dev/null; then
    sleep 2
    running && continue
    cat "$files.log" >&2
    stop
    exit 1
  fi
  sleep 1
done
echo "Nobody approved ${joiner.hostname} within 15 minutes." >&2
stop
exit 1
`;

// Joins the node `joiner` describes, showing the operator the URL to approve it at unless it is on
// the tailnet already. Returns what it says about itself.
const joinWith = Effect.fn("NixEngine.joinWith")(function* (
	target: Connection,
	joiner: Joiner,
	approve: Approve,
) {
	const url = (yield* target.run(`sh -c ${shellQuote(startJoining(joiner))}`)).trim();

	if (url !== "") yield* approve(url);

	const printed = yield* target.run(`sh -c ${shellQuote(finishJoining(joiner))}`);

	return yield* Effect.fromOption(
		joinedFrom(printed),
		() =>
			new EngineError({
				message: `${joiner.hostname} joined the tailnet without an IPv4 address or a name:\n${printed}`,
			}),
	);
});

// Joins the system's own node, through its tailscaled.
const join = (target: Connection, hostname: string, tag: string, approve: Approve) =>
	joinWith(
		target,
		{ hostname, flags: `--advertise-tags=${tag}`, bin: "", directory: Option.none() },
		approve,
	);

// Marks Wi-Fi networks the boot loader has yet to put into the initrd, until a boot loader install does.
const wifiPending = `${unlockDirectory}/wifi-pending`;

// Where NetworkManager keeps its connection profiles, the first shadowing the others: runtime ones,
// then persistent ones, then those the system ships.
const profileDirectories = [
	"/run/NetworkManager/system-connections",
	"/etc/NetworkManager/system-connections",
	"/usr/lib/NetworkManager/system-connections",
];

// The Wi-Fi networks NetworkManager knows on `target`, as wpa_supplicant's configuration for the initrd.
const wifiConfig = Effect.fn("NixEngine.wifiConfig")(function* (target: Connection) {
	const separator = "\n--- aett ---\n";

	const keyfiles = yield* target.run(
		`for file in ${profileDirectories.map((directory) => `${directory}/*.nmconnection`).join(" ")}; do [ -f "$file" ] && cat "$file" && printf ${shellQuote(separator)}; done; true`,
	);

	return wpaSupplicant(keyfiles.split(separator));
});

// Hands the Wi-Fi networks NetworkManager knows to the initrd as wpa_supplicant's configuration,
// which only root can read. Says whether the boot loader has yet to put them into the initrd.
const unlockWifi = Effect.fn("NixEngine.unlockWifi")(function* (target: Connection) {
	const said = yield* target.run(
		`umask 077 && next=$(mktemp) && cat > "$next" && if cmp -s "$next" ${unlockDirectory}/wpa_supplicant.conf; then rm -f "$next"; else mv -f "$next" ${unlockDirectory}/wpa_supplicant.conf && touch ${wifiPending}; fi && if [ -e ${wifiPending} ]; then echo pending; fi`,
		yield* wifiConfig(target),
	);

	return said.trim() === "pending";
});

// The address `target` reaches the internet from: its own on its LAN.
const lanAddress = (target: Connection) =>
	target
		.run(
			"ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p' | head -n 1",
		)
		.pipe(
			Effect.map((printed) =>
				Option.filter(Option.some(printed.trim()), (address) => address !== ""),
			),
		);

// Installs the boot loader again for the system the machine runs, which appends the initrd's
// secrets as they are now.
const refreshBoot = (target: Connection) =>
	target
		.stream(`/run/current-system/bin/switch-to-configuration boot >&2 && rm -f ${wifiPending}`)
		.pipe(Effect.asVoid);

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
 * the NixOS and nix-darwin modules; every build starts as a copy of it with
 * fleet.json, the machines' facts and the plugins' modules added. `plugins`
 * holds the plugins aett ships.
 */
export const nixEngine = (flake: string, plugins: string) =>
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

			const discovered = Effect.fn("NixEngine.discovered")(function* (root: string, name: string) {
				const file = path.join(root, "state", name, "facter.json");

				if (!(yield* fs.exists(file))) return Option.none<Platform>();

				return Option.some(
					yield* fs.readFileString(file).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(ReportedSystem)),
						Effect.map(({ system }) => system),
						Effect.catchTag("SchemaError", () =>
							Effect.fail(
								new EngineError({
									message: `state/${name}/facter.json names no platform aett builds for.`,
								}),
							),
						),
					),
				);
			});

			// Copies aett's flake to `directory`, locked to `inputs` instead of the lock it ships.
			const copyFlake = Effect.fn("NixEngine.copyFlake")(function* (
				directory: string,
				inputs: InputsLock,
			) {
				yield* fs.copy(flake, directory);

				// Copies out of the Nix store are read-only, and the next emit has to delete them.
				const entries = yield* fs.readDirectory(directory, { recursive: true });

				yield* Effect.forEach(
					[directory, ...entries.map((entry) => path.join(directory, entry))],
					(entry) =>
						fs.stat(entry).pipe(Effect.flatMap(({ mode }) => fs.chmod(entry, mode | 0o200))),
				);

				yield* fs.writeFileString(
					path.join(directory, "flake.lock"),
					`${JSON.stringify(inputs, null, 2)}\n`,
				);
			});

			// Reads a flake.lock, failing with an EngineError that names it when it isn't one.
			const readLock = (file: string) =>
				fs.readFileString(file).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Lock)),
					Effect.catchTag("SchemaError", (error) =>
						Effect.fail(
							new EngineError({
								message: `${file} is not a flake lock aett can read: ${error.message}`,
							}),
						),
					),
				);

			const defaultInputs = readLock(path.join(flake, "flake.lock"));

			const emit = Effect.fn("NixEngine.emit")(function* (
				root: string,
				fleet: Fleet,
				state: State,
				extras: Extras,
				pins: Pins,
			) {
				const emitted = fleetJson(fleet, state, extras, pins);
				const directory = path.join(root, ".aett", "build");

				yield* fs.remove(directory, { recursive: true, force: true });
				yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
				yield* copyFlake(directory, pins.inputs);

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

				// Every plugin a machine has brings its modules, as plugins/<name>/ next to flake.nix.
				yield* Effect.forEach([...fleet.services.values()], ({ plugin }) =>
					fs.copy(
						pluginDirectory(plugins, root, plugin),
						path.join(directory, "plugins", plugin.name),
					),
				);

				// sops-nix on each machine decrypts these; secrets.nix lists them for it.
				yield* Effect.forEach(
					machineSecrets(fleet).filter(({ name }) => extras.secrets.includes(name)),
					({ file }) =>
						fs
							.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
							.pipe(Effect.andThen(fs.copyFile(path.join(root, file), path.join(directory, file)))),
				);

				const macs = fleet.machines.flatMap(({ name, kind }) =>
					kind === "macos" && machines.includes(name) ? [name] : [],
				);

				return { directory, machines, macs } satisfies Build;
			});

			const evaluate = Effect.fn("NixEngine.evaluate")(function* (build: Build, name: string) {
				const configuration = build.macs.includes(name)
					? `darwinConfigurations.${name}`
					: `nixosConfigurations.${name}`;

				return yield* nix([
					"eval",
					"--raw",
					`${flakeAt(build.directory)}#${configuration}.config.system.build.toplevel.drvPath`,
				]);
			});

			const systemPaths = Effect.fn("NixEngine.systemPaths")(function* (
				build: Build,
				names: ReadonlyArray<string>,
			) {
				// Machine names are hostnames, so their JSON strings are Nix strings too.
				const output = yield* nix([
					"eval",
					"--json",
					`${flakeAt(build.directory)}#nixosConfigurations`,
					"--apply",
					`configurations: builtins.listToAttrs (map (name: { inherit name; value = configurations.\${name}.config.system.build.toplevel.outPath; }) [ ${names.map((name) => JSON.stringify(name)).join(" ")} ])`,
				]);

				return yield* Schema.decodeUnknownEffect(SystemPaths)(output).pipe(
					Effect.map((paths) => new Map(Object.entries(paths))),
					Effect.catchTag("SchemaError", (error) =>
						Effect.fail(
							new EngineError({ message: `nix eval printed unexpected output: ${error.message}` }),
						),
					),
				);
			});

			// Copies the build and its locked inputs into the target's store; returns the build's store path there.
			// nix reaches the target through its master connection: the pinned ssh first on PATH and the
			// connection's options in NIX_SSHOPTS, which nix splits like a shell. With more than one
			// connection nix would open its own master, which could not log in to an installer.
			// Copies the build's flake alone: the machine fetches its pinned inputs itself, from GitHub and
			// the binary caches, which is faster than through the controller when it is far away.
			const ship = Effect.fn("NixEngine.ship")(function* (build: Build, target: Connection) {
				yield* Console.log("Copying the fleet's flake…");

				// Archived here first, inputs included, which evaluating locked them into already.
				const stored = yield* nix(["flake", "archive", "--json", flakeAt(build.directory)]).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(ArchiveOutput)),
					Effect.map(({ path: source }) => source),
					Effect.catchTag("SchemaError", (error) =>
						Effect.fail(
							new EngineError({
								message: `nix flake archive printed unexpected output: ${error.message}`,
							}),
						),
					),
				);

				yield* nix(["copy", "--to", `ssh-ng://${target.destination}?max-connections=1`, stored], {
					PATH: `${yield* tools}:${inheritedPath}`,
					NIX_SSHOPTS: target.sshOptions.map(shellQuote).join(" "),
				});

				return stored;
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

			const switchToInstaller = Effect.fn("NixEngine.switchToInstaller")(function* (
				build: Build,
				target: Connection,
				keys: ReadonlyArray<string>,
			) {
				if ((yield* target.run("command -v nix >/dev/null && echo yes || true")).trim() !== "yes") {
					return yield* new EngineError({
						message:
							"The machine has no Nix to build the installer with. Boot it from the aett installer stick instead.",
					});
				}

				const source = yield* ship(build, target);

				yield* Console.log("Building the installer on it…");

				const kexec = (yield* target.stream(
					`nix build --no-link --print-out-paths --extra-experimental-features 'nix-command flakes' ${shellQuote(`${source}#packages.`)}"$(nix eval --raw --impure --extra-experimental-features nix-command --expr builtins.currentSystem)".installer-kexec`,
				)).trim();

				yield* Console.log("Switching it into the installer…");

				return yield* target
					.run(
						`keys=$(mktemp) && cat > "$keys" && ${shellQuote(`${kexec}/bin/aett-kexec`)} "$keys"`,
						`${keys.join("\n")}\n`,
					)
					.pipe(Effect.asVoid);
			});

			const install = Effect.fn("NixEngine.install")(function* (
				build: Build,
				name: string,
				target: Connection,
				secrets: InstallSecrets,
				tag: string,
				approve: Approve,
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

				// The machine joins from the installer before anything is erased, through a tailscaled of its
				// own whose identity the installed system boots with.
				const joined = yield* joinWith(
					target,
					{
						hostname: name,
						flags: `--advertise-tags=${tag}`,
						bin: `${toplevel}/sw/bin/`,
						directory: Option.some(joinDirectory),
					},
					approve,
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
				// Where persist.nix keeps /var/lib, the system's tailscaled's state directory among it.
				yield* target.run(
					`install -d -m 0700 /mnt/persist/var/lib/tailscale && cp -a ${joinDirectory}/. /mnt/persist/var/lib/tailscale/`,
				);

				// What unlock.nix puts into an encrypted machine's initrd, there before the boot loader install.
				const unlockKey = yield* Effect.transposeOption(
					Option.map(secrets.passphrase, () =>
						Effect.gen(function* () {
							const directory = `/mnt${unlockDirectory}`;

							yield* target.run(
								`install -d -m 0700 ${directory} && umask 077 && cat > ${directory}/wpa_supplicant.conf`,
								yield* wifiConfig(target),
							);

							return (yield* target.run(
								`ssh-keygen -q -t ed25519 -N "" -C ${shellQuote(`root@${name}-unlock`)} -f ${directory}/ssh_host_ed25519_key && cat ${directory}/ssh_host_ed25519_key.pub`,
							)).trim();
						}),
					),
				);

				yield* Console.log("Installing…");
				yield* target.run(
					`nixos-install --root /mnt --system ${shellQuote(toplevel)} --no-root-passwd --no-channel-copy`,
				);

				return { joined, unlockKey } satisfies Installed;
			});

			// Locks a scratch copy of the flake, which lists no machines, so nothing but the inputs is read.
			const updateInputs = Effect.fn("NixEngine.updateInputs")(function* (
				inputs: InputsLock,
				names: ReadonlyArray<string>,
			) {
				const directory = path.join(
					yield* fs.makeTempDirectoryScoped({ prefix: "aett-" }),
					"flake",
				);

				yield* copyFlake(directory, inputs);
				yield* nix(["flake", "update", ...names, "--flake", flakeAt(directory)]);

				return yield* readLock(path.join(directory, "flake.lock"));
			}, Effect.scoped);

			// Evaluates flake.nix's lib.sources in a scratch copy of the flake locked to `inputs`.
			const packageSources = Effect.fn("NixEngine.packageSources")(function* (
				inputs: InputsLock,
				platform: Platform,
				channel: Channel,
				names: ReadonlyArray<string>,
			) {
				if (names.length === 0) return new Map<string, Option.Option<Source>>();

				const directory = path.join(
					yield* fs.makeTempDirectoryScoped({ prefix: "aett-" }),
					"flake",
				);

				yield* copyFlake(directory, inputs);

				// Package names are attribute paths, so their JSON strings are Nix strings too.
				const output = yield* nix([
					"eval",
					"--json",
					`${flakeAt(directory)}#lib`,
					"--apply",
					`lib: lib.sources ${JSON.stringify(platform)} ${JSON.stringify(channel)} [ ${names.map((name) => JSON.stringify(name)).join(" ")} ]`,
				]);

				const found = yield* Schema.decodeUnknownEffect(Sources)(output).pipe(
					Effect.catchTag("SchemaError", (error) =>
						Effect.fail(
							new EngineError({ message: `nix eval printed unexpected output: ${error.message}` }),
						),
					),
				);

				return new Map(
					names.map((name) => [name, Option.fromNullOr(found[name] ?? null)] as const),
				);
			}, Effect.scoped);

			// The pinned tools and the operator's terminal for a command that may ask for sudo's password.
			const interactive = Effect.fn("NixEngine.interactive")(function* (
				args: ReadonlyArray<string>,
				input?: string,
			) {
				const exitCode = yield* spawner
					.exitCode(
						// Attached to aett's terminal, where sudo asks for the password or Touch ID.
						// -H: root's own home, not the operator's, for what runs as root.
						ChildProcess.make("/usr/bin/sudo", ["-H", ...args], {
							stdin: input === undefined ? "inherit" : Stream.make(new TextEncoder().encode(input)),
							stdout: "inherit",
							stderr: "inherit",
							detached: false,
						}),
					)
					.pipe(
						Effect.mapError(
							(error) => new EngineError({ message: `Could not run sudo: ${error.message}` }),
						),
					);

				return yield* exitCode === 0
					? Effect.void
					: new EngineError({
							message: `sudo ${args.join(" ")} failed with exit code ${exitCode}.`,
						});
			});

			const buildDarwin = Effect.fn("NixEngine.buildDarwin")(function* (
				build: Build,
				name: string,
			) {
				yield* Console.log(`Building ${name}…`);

				return yield* nix([
					"build",
					"--no-link",
					"--print-out-paths",
					`${flakeAt(build.directory)}#darwinConfigurations.${name}.system`,
				]);
			});

			const brewfile = (build: Build, name: string) =>
				nix([
					"eval",
					"--raw",
					`${flakeAt(build.directory)}#darwinConfigurations.${name}.config.homebrew.brewfile`,
				]);

			// As darwin-rebuild switch: the profile first, then the system's activation, both as root.
			const activateDarwin = Effect.fn("NixEngine.activateDarwin")(function* (
				system: string,
				ageKey: Redacted.Redacted,
			) {
				yield* interactive(
					[
						"/bin/sh",
						"-c",
						"install -d -m 0700 /var/lib/sops-nix && umask 077 && cat > /var/lib/sops-nix/key.txt",
					],
					`${Redacted.value(ageKey)}\n`,
				);
				// sudo's secure PATH lacks Nix; the daemon's profile has it on every multi-user install.
				yield* interactive([
					"/nix/var/nix/profiles/default/bin/nix-env",
					"--profile",
					"/nix/var/nix/profiles/system",
					"--set",
					system,
				]);
				// The Nix installer's own nix.custom.conf stands where darwin/machine.nix puts aett's, and
				// nix-darwin refuses to replace a file it doesn't know. It is kept beside it.
				yield* interactive([
					"/bin/sh",
					"-c",
					`f=/etc/nix/nix.custom.conf; if [ -e ${shellQuote(`${system}/etc/nix/nix.custom.conf`)} ] && [ -f "$f" ] && [ ! -L "$f" ]; then mv "$f" "$f.before-nix-darwin" && echo "Moved $f to $f.before-nix-darwin; aett writes Nix's settings there now." >&2; fi`,
				]);
				yield* interactive([`${system}/activate`]);
			});

			const prefetch = Effect.fn("NixEngine.prefetch")(function* (url: string) {
				const output = yield* nix([
					"store",
					"prefetch-file",
					"--json",
					"--hash-type",
					"sha256",
					url,
				]);

				return yield* Schema.decodeUnknownEffect(PrefetchOutput)(output).pipe(
					Effect.map(({ hash }) => hash),
					Effect.catchTag("SchemaError", () =>
						Effect.fail(new EngineError({ message: `nix printed no hash for ${url}.` })),
					),
				);
			});

			return Engine.of({
				tools,
				defaultInputs,
				systemPaths,
				updateInputs,
				prefetch,
				packageSources,
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
				join,
				switchToInstaller,
				lanAddress,
				unlockWifi,
				refreshBoot,
				buildDarwin,
				brewfile,
				activateDarwin,
				install,
			});
		}),
	);
