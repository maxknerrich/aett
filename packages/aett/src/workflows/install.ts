import { Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Nix } from "../adapters/nix.ts";
import { Secrets } from "../adapters/secrets.ts";
import { type Connection, shellQuote, Ssh } from "../adapters/ssh.ts";
import {
	type Disk,
	diskLabel,
	FacterReport,
	findDisk,
	internalDisks,
	layoutPreview,
} from "../domain/disk.ts";
import type { Fleet } from "../domain/fleet.ts";
import { formatHost, type Host, trustHost } from "../domain/host.ts";
import { type MachineRecord, SshPublicKey } from "../domain/state.ts";
import { emit } from "./compile.ts";
import { loadFleet, readState } from "./load.ts";

export class InstallError extends Schema.TaggedError<InstallError>()("InstallError", {
	message: Schema.String,
}) {}

/** How the operator reaches the installer: its address and, unless aett should ask, its code. */
export interface InstallerAccess {
	readonly host: Host;
	readonly code: Option.Option<Redacted.Redacted>;
}

/** The answers `aett machine install` takes as flags instead of prompts. */
export interface InstallOptions extends InstallerAccess {
	readonly disk: Option.Option<string>;
	readonly yes: boolean;
	readonly reinstall: boolean;
}

/** Connects to the installer and saves its hardware report as `state/<name>/facter.json`. */
export const discover = Effect.fn("discover")(function* (
	root: string,
	name: string,
	access: InstallerAccess,
) {
	yield* declared(yield* loadFleet(root), name);
	yield* discoverFacts(root, name, yield* connect(access));
}, Effect.scoped);

/**
 * Discovers the machine, lets the operator confirm its disk, builds its system
 * on the installer, erases the disk, installs with the machine's stored host
 * key and reboots into the new system.
 */
export const install = Effect.fn("install")(function* (
	root: string,
	name: string,
	options: InstallOptions,
) {
	const nix = yield* Nix;
	const fleet = yield* loadFleet(root);

	yield* declared(fleet, name);

	const state = yield* readState(root, fleet);
	const recorded = state.machines.get(name);

	if (recorded?.installed === true && !options.reinstall) {
		return yield* new InstallError({
			message: `${name} is already installed. Pass --reinstall to erase it and install it again.`,
		});
	}

	// Before anything is erased, so a reinstall that cannot decrypt the stored key stops here.
	const hostKey = yield* machineHostKey(root, name, state.operator.age);

	const connection = yield* connect(options);
	const disks = internalDisks(yield* discoverFacts(root, name, connection));
	const disk = yield* chooseDisk(name, recorded?.disk, options.disk, disks);

	yield* Console.log(`\n${layoutPreview(name, disk)}\n`);

	if (!options.yes) {
		const typed = yield* Prompt.String({ message: `Type "${name}" to erase this disk:` });

		if (typed !== name) {
			return yield* new InstallError({
				message: `"${typed}" is not "${name}". Nothing was erased.`,
			});
		}
	}

	// Later runs read the disk from state and never derive it again.
	// An existing record stays as it is, so `installed` survives a failed reinstall.
	if (recorded?.disk === undefined) yield* writeRecord(root, name, { disk: disk.byId });

	const { build } = yield* emit(root);

	yield* Console.log("Copying aett's flake and its inputs to the installer…");

	const source = yield* nix.archive(build, connection);

	yield* Console.log(`Building ${name} on the installer…`);

	const [toplevel, formatDisk, prepare] = yield* buildOn(connection, source, name);

	yield* Console.log(`Erasing ${disk.byId}…`);
	yield* connection.run(
		`${shellQuote(`${formatDisk}/bin/disko-destroy-format-mount`)} --yes-wipe-all-disks`,
	);
	yield* connection.run(`${shellQuote(prepare)} /mnt`);
	// Where the NixOS module points sshd. sshd ignores a private key that others can read.
	yield* connection.run(
		"mkdir -p /mnt/persist/etc/ssh && umask 077 && cat > /mnt/persist/etc/ssh/ssh_host_ed25519_key",
		hostKey.privateKey,
	);
	yield* connection.run(
		"umask 022 && cat > /mnt/persist/etc/ssh/ssh_host_ed25519_key.pub",
		`${hostKey.publicKey}\n`,
	);
	yield* Console.log("Installing…");
	yield* connection.run(
		`nixos-install --root /mnt --system ${shellQuote(toplevel)} --no-root-passwd --no-channel-copy`,
	);
	yield* writeRecord(root, name, { disk: disk.byId, installed: true });
	yield* trustHostKey(root, name, hostKey.publicKey);
	yield* Console.log(`Installed ${name}. It reboots now and comes back as ${name}.local.`);

	// The reboot drops the connection, which may fail the command; that is expected.
	return yield* Effect.ignore(connection.run("systemctl reboot"));
}, Effect.scoped);

const declared = (fleet: Fleet, name: string) =>
	fleet.machines.some((machine) => machine.name === name)
		? Effect.void
		: Effect.fail(new InstallError({ message: `fleet.ts declares no machine named "${name}".` }));

// Logs in to the installer, asking for its code unless --code gave it.
const connect = Effect.fn("connect")(function* ({ host, code }: InstallerAccess) {
	const ssh = yield* Ssh;

	const secret = yield* Option.match(code, {
		onSome: Effect.succeed,
		onNone: () => Prompt.Password({ message: "Installer code (shown on its console)" }),
	});

	yield* Console.log(`Connecting to the installer at ${formatHost(host)}…`);

	return yield* ssh.installer(host, secret);
});

// Saves the nixos-facter report exactly as printed, once it proves readable.
const discoverFacts = Effect.fn("discoverFacts")(function* (
	root: string,
	name: string,
	connection: Connection,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* Console.log("Running nixos-facter on the installer…");

	const report = yield* connection.run("nixos-facter");

	const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FacterReport))(
		report,
	).pipe(
		Effect.catchTag("SchemaError", (error) =>
			Effect.fail(
				new InstallError({
					message: `nixos-facter printed a report aett cannot read: ${error.message}`,
				}),
			),
		),
	);

	yield* fs.makeDirectory(path.join(root, "state", name), { recursive: true });
	yield* fs.writeFileString(path.join(root, "state", name, "facter.json"), report);
	yield* Console.log(`Wrote state/${name}/facter.json`);

	return decoded;
});

// The recorded disk wins; otherwise --disk, the only internal disk or the operator's choice.
const chooseDisk = Effect.fn("chooseDisk")(function* (
	name: string,
	recorded: string | undefined,
	requested: Option.Option<string>,
	disks: ReadonlyArray<Disk>,
) {
	const choices = disks.map((disk) => `\n  ${diskLabel(disk)}`).join("");

	if (recorded !== undefined) {
		const disk = yield* Effect.fromOption(
			findDisk(disks, recorded),
			() =>
				new InstallError({
					message: `state/${name}/machine.json records ${recorded}, which the installer does not see. Its internal disks:${choices}`,
				}),
		);

		if (Option.isSome(requested) && !disk.names.includes(requested.value)) {
			return yield* new InstallError({
				message: `state/${name}/machine.json records ${recorded} as the disk, not ${requested.value}.`,
			});
		}

		return { ...disk, byId: recorded };
	}

	if (Option.isSome(requested)) {
		return yield* Effect.fromOption(
			findDisk(disks, requested.value),
			() =>
				new InstallError({
					message: `--disk ${requested.value} is none of the installer's internal disks:${choices}`,
				}),
		);
	}

	const [only, ...others] = disks;

	if (only === undefined) {
		return yield* new InstallError({
			message: "The installer sees no internal disk with a /dev/disk/by-id/ link.",
		});
	}

	if (others.length === 0) return only;

	return yield* Prompt.Select({
		message: `Which disk should ${name} use? aett erases it.`,
		choices: disks.map((disk) => ({ title: diskLabel(disk), value: disk })),
	});
});

// Builds the system, its disk script and its persist setup on the installer, streaming the build log.
const buildOn = Effect.fn("buildOn")(function* (
	connection: Connection,
	source: string,
	name: string,
) {
	const outputs = ["toplevel", "destroyFormatMount", "aettInstall"].map((output) =>
		shellQuote(`${source}#nixosConfigurations.${name}.config.system.build.${output}`),
	);

	const printed = yield* connection.stream(
		`nix build --no-link --print-out-paths ${outputs.join(" ")}`,
	);

	return yield* Schema.decodeUnknownEffect(BuiltPaths)(printed.trim().split("\n")).pipe(
		Effect.catchTag("SchemaError", () =>
			Effect.fail(
				new InstallError({ message: `nix build printed unexpected store paths:\n${printed}` }),
			),
		),
	);
});

// One store path per output nix build was asked for, in that order.
const BuiltPaths = Schema.Tuple([Schema.String, Schema.String, Schema.String]);

// Writes state/<name>/machine.json.
const writeRecord = Effect.fn("writeRecord")(function* (
	root: string,
	name: string,
	record: MachineRecord,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.writeFileString(
		path.join(root, "state", name, "machine.json"),
		`${JSON.stringify(record, null, "\t")}\n`,
	);
});

const isSshPublicKey = Schema.is(SshPublicKey);

/**
 * The machine's SSH host key pair. The private key is the secret
 * secrets/<name>/ssh_host_ed25519_key.json, made on the controller by the
 * pinned ssh-keygen once and reused by every reinstall, so aett's known_hosts
 * entry stays valid.
 */
const machineHostKey = Effect.fn("machineHostKey")(function* (
	root: string,
	name: string,
	recipient: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const secrets = yield* Secrets;
	const keygen = path.join(yield* (yield* Nix).tools, "bin", "ssh-keygen");
	const file = path.join("secrets", name, "ssh_host_ed25519_key.json");

	// ssh-keygen reads and writes private keys only as files. This one lives until the scope closes.
	const keyFile = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "aett-" }), "key");

	const generate = spawner
		.exitCode(
			ChildProcess.make(
				keygen,
				["-q", "-t", "ed25519", "-N", "", "-C", `root@${name}`, "-f", keyFile],
				{ stdin: "ignore" },
			),
		)
		.pipe(
			Effect.filterOrFail(
				(exitCode) => exitCode === 0,
				() => new InstallError({ message: `ssh-keygen could not make a host key for ${name}.` }),
			),
			Effect.andThen(fs.readFileString(keyFile)),
		);

	const privateKey = yield* secrets.ensure(root, file, recipient, generate);

	// The public key is derived rather than stored. ssh-keygen wants the private key in a file only its owner can read.
	yield* fs.writeFileString(keyFile, privateKey, { mode: 0o600 });

	const publicKey = (yield* spawner.string(
		ChildProcess.make(keygen, ["-y", "-f", keyFile], { stdin: "ignore" }),
	)).trim();

	if (!isSshPublicKey(publicKey)) {
		return yield* new InstallError({ message: `${file} holds no SSH private key.` });
	}

	return { privateKey, publicKey };
}, Effect.scoped);

// Records the machine's host key in aett's known_hosts, replacing whatever it held for the machine.
const trustHostKey = Effect.fn("trustHostKey")(function* (
	root: string,
	name: string,
	publicKey: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, "state", "known_hosts");
	const knownHosts = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";

	yield* fs.writeFileString(file, trustHost(knownHosts, name, publicKey));
});
