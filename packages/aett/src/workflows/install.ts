import { Console, Effect, FileSystem, Option, Path, Redacted, Schedule, Schema } from "effect";
import { Prompt } from "effect/cli";
import { Secrets } from "../adapters/secrets.ts";
import { type Connection, Ssh } from "../adapters/ssh.ts";
import {
	type Disk,
	diskLabel,
	findDisk,
	isPassphrase,
	layoutPreview,
	nasPreview,
	poolProblem,
} from "../domain/disk.ts";
import { type Fleet, guestsOf } from "../domain/fleet.ts";
import { formatHost, type Host } from "../domain/host.ts";
import { joinedFrom, tagOf } from "../domain/tailnet.ts";
import { Engine } from "../engine/engine.ts";
import { emit } from "./compile.ts";
import { machineHostKey, trustHostKey } from "./identity.ts";
import { forgetRecord, loadFleet, readState, updateRecord } from "./load.ts";
import { approver, syncPolicy } from "./tailscale.ts";
import { unlockName } from "./unlock.ts";

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
	/** A NAS's disks for each pool, by any of their /dev names; aett asks when they are missing. */
	readonly rootDisks: ReadonlyArray<string>;
	readonly tankDisks: ReadonlyArray<string>;
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
 * its host key and disk passphrase, builds its system on the installer, joins
 * it to the tailnet once the operator approves it, erases the disk (inside
 * LUKS when declared encrypted), installs and reboots into the new system.
 */
export const install = Effect.fn("install")(function* (
	root: string,
	name: string,
	options: InstallOptions,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
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

	// The installed machine is reached only over the tailnet, which it joins with its role's tag.
	yield* syncPolicy(root, fleet);

	const connection = yield* reachInstaller(root, name, state.operator.sshKeys, options);
	const { disks, uefi } = yield* engine.discover(root, name, connection);

	// Installed systems boot with systemd-boot, so a machine booted without UEFI would be left unbootable.
	if (!uefi) {
		return yield* new InstallError({
			message: `The installer on ${name} didn't boot via UEFI, and aett installs UEFI systems only. Nothing was erased. Boot the stick in UEFI mode (the firmware's boot menu usually lists it with "UEFI") and run install again.`,
		});
	}

	// A NAS erases every disk of its two pools; any other machine one disk.
	const layout =
		machine.role === "nas"
			? { pools: yield* choosePools(name, recorded?.pools, options, disks) }
			: { disk: yield* chooseDisk(name, recorded?.disk, options.disk, disks) };

	yield* Console.log(
		`\n${"pools" in layout ? nasPreview(machine, layout.pools) : layoutPreview(machine, layout.disk)}\n`,
	);

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
	const hostKey = yield* machineHostKey(root, name, state.operator.ageKeys);

	const passphrase = machine.encrypted
		? Option.some(yield* diskPassphrase(root, name, state.operator.ageKeys, options.passphrase))
		: Option.none();

	// Trusted before the build, so the machine is a recipient of the secrets it reads on first boot.
	yield* trustHostKey(root, name, hostKey.publicKey);

	// Erasing the disk erases the machine's tailnet identity and its guests', so they join again:
	// the machine at this install, its guests at its first apply. A failure puts their
	// records back. Their old nodes stay on the tailnet until the operator removes them.
	const reinstalling = recorded?.installed === true;

	// Its guests' identities live on its disk too.
	const erased = [
		...new Set([
			name,
			...guestsOf(fleet, name),
			...[...state.machines].flatMap(([guest, { host }]) => (host === name ? [guest] : [])),
		]),
	];

	const before = yield* Effect.forEach(erased, (machineName) =>
		Effect.gen(function* () {
			const record = path.join(root, "state", machineName, "machine.json");

			return (yield* fs.exists(record))
				? [{ record, content: yield* fs.readFileString(record) }]
				: [];
		}),
	);

	const oldNodes = erased.flatMap((machineName) =>
		Option.toArray(Option.fromUndefinedOr(state.machines.get(machineName)?.tailnetName)),
	);

	if (reinstalling) {
		yield* Effect.forEach(erased, (machineName) =>
			forgetRecord(root, machineName, ["tailnet", "tailnetName", "unlock"]),
		);
	}

	const restore = Effect.forEach(before.flat(), ({ record, content }) =>
		fs.writeFileString(record, content),
	);

	// Later runs read the disks from state and never derive them again.
	// An existing record stays as it is, so `installed` survives a failed reinstall.
	const chosen =
		"pools" in layout
			? {
					pools: {
						root: layout.pools.root.map(({ byId }) => byId),
						tank: layout.pools.tank.map(({ byId }) => byId),
					},
				}
			: { disk: layout.disk.byId };

	// A role that changed from or to nas() needs the other layout recorded instead.
	if ("pools" in chosen ? recorded?.pools === undefined : recorded?.disk === undefined) {
		yield* forgetRecord(root, name, ["disk", "pools"]);
		yield* updateRecord(root, name, chosen);
	}

	// An encrypted machine's initrd answers on its LAN from the first boot, where the installer is now.
	if (machine.encrypted) {
		const address = yield* Effect.fromOption(
			yield* engine.lanAddress(connection),
			() =>
				new InstallError({
					message: `The installer on ${name} has no route to the internet, so aett can't tell its LAN address. Nothing was erased.`,
				}),
		);

		yield* updateRecord(root, name, { unlock: { address } });
	}

	const installed = yield* Effect.gen(function* () {
		const { build } = yield* emit(root);

		// The machine's guests start on its first boot, so their host keys go on its disk too.
		const keys = new Map(
			yield* Effect.forEach(
				guestsOf(fleet, name).filter((guest) => build.machines.includes(guest)),
				(guest) =>
					machineHostKey(root, guest, state.operator.ageKeys).pipe(
						Effect.map((key) => [guest, key] as const),
					),
			),
		);

		if (oldNodes.length > 0) {
			yield* Console.log(
				`Remove the old ${oldNodes.join(", ")} from the tailnet at https://login.tailscale.com/admin/machines before you approve ${name}, so the new nodes get their names.`,
			);
		}

		const done = yield* engine.install(
			build,
			name,
			connection,
			{ hostKey, guests: keys, passphrase },
			tagOf(machine.role),
			yield* approver(name),
		);

		return { keys, ...done };
	}).pipe(Effect.onError(() => Effect.ignore(restore)));

	yield* updateRecord(root, name, {
		...chosen,
		encrypted: machine.encrypted,
		installed: true,
		tailnet: installed.joined.tailnet,
		tailnetName: installed.joined.tailnetName,
	});
	yield* Effect.forEach(installed.keys, ([guest, key]) => trustHostKey(root, guest, key.publicKey));
	yield* Effect.forEach(Option.toArray(installed.unlockKey), (key) =>
		trustHostKey(root, unlockName(name), key),
	);
	yield* Console.log(
		machine.encrypted
			? `Installed ${name}, on the tailnet as ${installed.joined.tailnetName}. It reboots now and waits for its passphrase: aett machine unlock ${name} opens it from its LAN, or type it at its console.`
			: `Installed ${name}, on the tailnet as ${installed.joined.tailnetName}. It reboots now.`,
	);

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
/**
 * Logs in to the installer at `options.host` for install. Without --code it
 * tries the operators' keys first: a machine that lets them in and still runs
 * another Linux is switched into the installer in memory, once the operator
 * agrees, and aett logs in to that installer on the machine's LAN. Its disks
 * stay as they are until install erases them. Otherwise it asks for the code
 * a stick-booted installer shows.
 */
const reachInstaller = Effect.fn("reachInstaller")(function* (
	root: string,
	name: string,
	keys: ReadonlyArray<string>,
	options: InstallOptions,
) {
	const ssh = yield* Ssh;
	const engine = yield* Engine;

	const running = yield* Option.match(options.code, {
		onSome: () => Effect.succeed(Option.none()),
		onNone: () => ssh.takeover(options.host).pipe(Effect.option),
	});

	if (Option.isNone(running)) return yield* connect(options);

	if (yield* isInstaller(running.value)) return running.value;

	const system = (yield* running.value.run(
		'. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}"',
	)).trim();

	const node = joinedFrom(
		yield* running.value.run("tailscale status --json --peers=false 2>/dev/null || true"),
	);

	const lan = Option.getOrElse(yield* engine.lanAddress(running.value), () => options.host.name);

	yield* Console.log(
		`${name} at ${formatHost(options.host)} runs ${system}. aett switches it into the installer in memory, without a USB stick; nothing is erased until you confirm its disks.`,
	);

	yield* Effect.forEach(Option.toArray(node), ({ tailnetName }) =>
		Console.log(
			`It is on your tailnet as ${tailnetName}. Remove that node at https://login.tailscale.com/admin/machines before you approve ${name} later, so the new one gets its name.`,
		),
	);

	if (
		!options.yes &&
		!(yield* Prompt.Confirm({ message: `Switch ${name} into the installer now?` }))
	) {
		return yield* new InstallError({ message: `Left ${name} as it is.` });
	}

	const { build } = yield* emit(root);

	yield* engine.switchToInstaller(build, running.value, keys);

	// The installer isn't on the tailnet: aett finds it on the machine's LAN.
	const installer = { name: lan, port: 22 };

	yield* Console.log(`Waiting for the installer on ${name} at ${formatHost(installer)}…`);

	return yield* ssh.takeover(installer).pipe(
		Effect.flatMap((connection) =>
			Effect.flatMap(isInstaller(connection), (ready) =>
				ready
					? Effect.succeed(connection)
					: Effect.fail(
							new InstallError({ message: `${name} at ${lan} isn't the installer yet.` }),
						),
			),
		),
		Effect.retry(Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "10 minutes" }))),
		Effect.mapError(
			(error) =>
				new InstallError({
					message: `${error.message}\nThe installer on ${name} didn't answer at ${lan}. aett reaches it on ${name}'s LAN, so from elsewhere connect to that LAN first, such as over your VPN. Its console shows what happened.`,
				}),
		),
	);
});

// Whether `connection` is to the aett installer rather than to a system it replaces.
const isInstaller = (connection: Connection) =>
	connection
		.run("test -e /etc/aett-installer && echo yes || true")
		.pipe(Effect.map((said) => said.trim() === "yes"));

const connect = Effect.fn("connect")(function* ({ host, code }: InstallerAccess) {
	const ssh = yield* Ssh;

	const secret = yield* Option.match(code, {
		onSome: Effect.succeed,
		onNone: () => Prompt.Password({ message: "Installer code (shown on its console)" }),
	});

	yield* Console.log(`Connecting to the installer at ${formatHost(host)}…`);

	return yield* ssh.installer(host, secret);
});

// A NAS's recorded pools win; otherwise --root-disk and --tank-disk, or the operator's choice,
// each pool mirroring at least two disks and no disk in both.
const choosePools = Effect.fn("choosePools")(function* (
	name: string,
	recorded:
		| { readonly root: ReadonlyArray<string>; readonly tank: ReadonlyArray<string> }
		| undefined,
	options: Pick<InstallOptions, "rootDisks" | "tankDisks">,
	disks: ReadonlyArray<Disk>,
) {
	const choices = disks.map((disk) => `\n  ${diskLabel(disk)}`).join("");

	// The disks `names` name, or an error that names the one the installer doesn't see.
	const named = (names: ReadonlyArray<string>, where: string) =>
		Effect.forEach(names, (path) =>
			Effect.fromOption(
				findDisk(disks, path),
				() =>
					new InstallError({
						message: `${where} names ${path}, which is none of the installer's internal disks:${choices}`,
					}),
			).pipe(
				Effect.map((disk) => ({ ...disk, byId: disk.names.includes(path) ? disk.byId : path })),
			),
		);

	const pick = (pool: string, taken: ReadonlyArray<Disk>) =>
		Prompt.MultiSelect({
			message: `Which disks form ${name}'s ${pool} pool? aett erases them.`,
			choices: disks.flatMap((disk) =>
				taken.some(({ byId }) => byId === disk.byId)
					? []
					: [{ title: diskLabel(disk), value: disk }],
			),
			min: 2,
		});

	const pools =
		recorded !== undefined
			? {
					root: yield* named(recorded.root, `state/${name}/machine.json`),
					tank: yield* named(recorded.tank, `state/${name}/machine.json`),
				}
			: yield* Effect.gen(function* () {
					const rootPool =
						options.rootDisks.length > 0
							? yield* named(options.rootDisks, "--root-disk")
							: yield* pick("root", []);

					const tank =
						options.tankDisks.length > 0
							? yield* named(options.tankDisks, "--tank-disk")
							: yield* pick("tank", rootPool);

					return { root: rootPool, tank };
				});

	return yield* Option.match(poolProblem(pools), {
		onNone: () => Effect.succeed(pools),
		onSome: (problem) =>
			Effect.fail(new InstallError({ message: `${problem} Nothing was erased.` })),
	});
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

/**
 * An encrypted machine's disk passphrase, which the operator types at its
 * console on every boot. It is the secret secrets/<name>/luks-passphrase.json,
 * chosen once through --passphrase-file or a prompt and reused by every
 * reinstall; the stored copy is the operator's recovery copy.
 */
const diskPassphrase = Effect.fn("diskPassphrase")(function* (
	root: string,
	name: string,
	recipients: ReadonlyArray<string>,
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
		recipients,
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
