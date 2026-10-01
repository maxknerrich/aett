import { Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Secrets } from "../adapters/secrets.ts";
import { Ssh } from "../adapters/ssh.ts";
import { type Disk, diskLabel, findDisk, isPassphrase, layoutPreview } from "../domain/disk.ts";
import type { Fleet } from "../domain/fleet.ts";
import { formatHost, type Host, trustHost } from "../domain/host.ts";
import { type MachineRecord, SshPublicKey } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";
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
	/** An encrypted machine's new disk passphrase. aett asks when it is missing and none is stored. */
	readonly passphrase: Option.Option<Redacted.Redacted>;
}

/** Connects to the installer and saves its hardware report in `state/<name>/`. */
export const discover = Effect.fn("discover")(function* (
	root: string,
	name: string,
	access: InstallerAccess,
) {
	yield* discoverable(yield* loadFleet(root), name);
	yield* (yield* Engine).discover(root, name, yield* connect(access));
}, Effect.scoped);

/**
 * Discovers the machine, lets the operator confirm its disk, makes or reads
 * its host key and disk passphrase, builds its system on the installer, erases
 * the disk (inside LUKS when declared encrypted), installs and reboots into the
 * new system.
 */
export const install = Effect.fn("install")(function* (
	root: string,
	name: string,
	options: InstallOptions,
) {
	const engine = yield* Engine;
	const fleet = yield* loadFleet(root);
	const machine = yield* installable(fleet, name);
	const state = yield* readState(root, fleet);
	const recorded = state.machines.get(name);

	if (recorded?.installed === true && !options.reinstall) {
		return yield* new InstallError({
			message: `${name} is already installed. Pass --reinstall to erase it and install it again.`,
		});
	}

	if (Option.isSome(options.passphrase) && !machine.encrypted) {
		return yield* new InstallError({
			message: `fleet.ts does not encrypt ${name}'s disk, so it has no passphrase. Declare system: { encrypted: true } or leave out --passphrase-file.`,
		});
	}

	const connection = yield* connect(options);
	const disks = yield* engine.discover(root, name, connection);
	const disk = yield* chooseDisk(name, recorded?.disk, options.disk, disks);

	yield* Console.log(`\n${layoutPreview(machine, disk)}\n`);

	if (!options.yes) {
		const typed = yield* Prompt.String({ message: `Type "${name}" to erase this disk:` });

		if (typed !== name) {
			return yield* new InstallError({
				message: `"${typed}" is not "${name}". Nothing was erased.`,
			});
		}
	}

	// Secrets come after connecting, so a run that can't reach the installer leaves none
	// behind, and before anything is erased, so a reinstall that can't decrypt them stops here.
	const hostKey = yield* machineHostKey(root, name, state.operator.age);

	const passphrase = machine.encrypted
		? Option.some(yield* diskPassphrase(root, name, state.operator.age, options.passphrase))
		: Option.none();

	// Later runs read the disk from state and never derive it again.
	// An existing record stays as it is, so `installed` survives a failed reinstall.
	if (recorded?.disk === undefined) yield* writeRecord(root, name, { disk: disk.byId });

	const { build } = yield* emit(root);

	yield* engine.install(build, name, connection, { hostKey, passphrase });
	yield* writeRecord(root, name, {
		disk: disk.byId,
		encrypted: machine.encrypted,
		installed: true,
	});
	yield* trustHostKey(root, name, hostKey.publicKey);
	yield* Console.log(`Installed ${name}. It reboots now and comes back as ${name}.local.`);

	// The reboot drops the connection, which may fail the command; that is expected.
	return yield* Effect.ignore(connection.run("systemctl reboot"));
}, Effect.scoped);

// The bare-metal NixOS machine fleet.ts declares as `name`: what the installer can discover.
const discoverable = (fleet: Fleet, name: string) =>
	Effect.fromOption(
		Option.fromUndefinedOr(fleet.machines.find((machine) => machine.name === name)),
		() => new InstallError({ message: `fleet.ts declares no machine named "${name}".` }),
	).pipe(
		Effect.filterOrFail(
			(machine) => machine.kind === "nixos",
			(machine) =>
				new InstallError({
					message: `${name} is ${machine.kind === "vm" ? "a VM" : "a Mac"}; the installer sets up bare-metal NixOS machines.`,
				}),
		),
	);

// The machine as discover allows it, and only if it declares nothing aett can't install yet.
const installable = (fleet: Fleet, name: string) =>
	discoverable(fleet, name).pipe(
		Effect.filterOrFail(
			(machine) => machine.unsupported.length === 0,
			(machine) =>
				new InstallError({
					message: `${name} uses what aett can't install yet: ${machine.unsupported.join(", ")}.`,
				}),
		),
	);

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
	const keygen = path.join(yield* (yield* Engine).tools, "ssh-keygen");
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

/**
 * An encrypted machine's disk passphrase, which the operator types at its
 * console on every boot. It is the secret secrets/<name>/luks-passphrase.json,
 * chosen once through --passphrase-file or a prompt and reused by every
 * reinstall; the stored copy is the operator's recovery copy.
 */
const diskPassphrase = Effect.fn("diskPassphrase")(function* (
	root: string,
	name: string,
	recipient: string,
	given: Option.Option<Redacted.Redacted>,
) {
	const path = yield* Path.Path;
	const secrets = yield* Secrets;
	const file = path.join("secrets", name, "luks-passphrase.json");
	const chosen = Option.map(given, Redacted.value);

	if (Option.isSome(chosen) && !isPassphrase(chosen.value)) {
		return yield* new InstallError({
			message: "--passphrase-file must hold the passphrase: one line that is not empty.",
		});
	}

	const passphrase = yield* secrets.ensure(
		root,
		file,
		recipient,
		Option.match(chosen, { onSome: Effect.succeed, onNone: () => choosePassphrase(name) }),
	);

	if (!isPassphrase(passphrase)) {
		return yield* new InstallError({
			message: `${file} does not hold a passphrase that can be typed at the console: one line that is not empty.`,
		});
	}

	if (Option.isSome(chosen) && chosen.value !== passphrase) {
		return yield* new InstallError({
			message: `--passphrase-file differs from ${name}'s stored passphrase in ${file}. A reinstall keeps the stored one; leave out --passphrase-file to use it.`,
		});
	}

	return passphrase;
});

// Asks for a new passphrase twice, starting over until both entries match.
const choosePassphrase = (name: string) =>
	Effect.gen(function* () {
		const passphrase = yield* Prompt.Password({
			message: `Disk passphrase for ${name}, typed at its console on every boot`,
			validate: (value) =>
				isPassphrase(value) ? Effect.succeed(value) : Effect.fail("Expected a passphrase"),
		});

		const repeated = yield* Prompt.Password({ message: "The same passphrase again" });
		const matches = Redacted.value(repeated) === Redacted.value(passphrase);

		if (!matches) yield* Console.log("The two entries differ. Choose the passphrase again.");

		return { passphrase: Redacted.value(passphrase), matches };
	}).pipe(
		Effect.repeat({ until: ({ matches }) => matches }),
		Effect.map(({ passphrase }) => passphrase),
	);
