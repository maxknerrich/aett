import { Effect, Path, Redacted } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { installerHost, parseHost } from "../domain/host.ts";
import { PackageManager, parseMachineFlag } from "../domain/scaffold.ts";
import { apply } from "../workflows/apply.ts";
import { compile } from "../workflows/compile.ts";
import { type AettPackage, create } from "../workflows/create.ts";
import { destroy } from "../workflows/destroy.ts";
import { fleetRoot } from "../workflows/load.ts";
import { discover, install } from "../workflows/install.ts";

const cwd = Effect.map(Effect.service(Path.Path), (path) => path.resolve());

// Fleet commands work on the nearest fleet from the current directory upwards.
const fleet = Effect.flatMap(cwd, fleetRoot);

const machineName = Argument.String("name").pipe(
	Argument.withDescription("The machine's name in fleet.ts."),
);

const hostFlag = (description: string) =>
	Flag.String("host").pipe(
		Flag.withDescription(description),
		Flag.filterMap(parseHost, () => "Expected host[:port]"),
	);

const installerFlags = {
	host: hostFlag("The installer as host[:port]. Defaults to aett-installer.local.").pipe(
		Flag.withDefault(installerHost),
	),
	code: Flag.Redacted("code").pipe(
		Flag.withDescription(
			"The code on the installer's console, which logs in as root. aett asks when it is missing.",
		),
		Flag.optional,
	),
};

const machine = Command.make("machine").pipe(
	Command.withDescription("Discover, install and destroy machines."),
	Command.withSubcommands([
		Command.make("discover", { name: machineName, ...installerFlags }, ({ name, ...access }) =>
			Effect.flatMap(fleet, (root) => discover(root, name, access)),
		).pipe(Command.withDescription("Save the installer's hardware report in state/<name>/.")),
		Command.make(
			"install",
			{
				name: machineName,
				...installerFlags,
				disk: Flag.String("disk").pipe(
					Flag.withDescription(
						"The disk to erase, by any of its /dev names. Needed only when the machine has several internal disks.",
					),
					Flag.optional,
				),
				yes: Flag.Boolean("yes").pipe(
					Flag.withDescription("Erase the disk without asking for the machine's name."),
					Flag.withDefault(false),
				),
				reinstall: Flag.Boolean("reinstall").pipe(
					Flag.withDescription(
						"Install a machine state marks installed again, on its recorded disk with its stored host key and disk passphrase.",
					),
					Flag.withDefault(false),
				),
				// A file keeps the passphrase out of argv and shell history.
				passphrase: Flag.FileText("passphrase-file").pipe(
					Flag.withDescription(
						"A file holding the new disk passphrase of a machine declared with disk: { encrypted: true }. aett asks when it is missing.",
					),
					Flag.map((text) => Redacted.make(text.replace(/\r?\n$/, ""))),
					Flag.optional,
				),
			},
			({ name, ...options }) => Effect.flatMap(fleet, (root) => install(root, name, options)),
		).pipe(
			Command.withDescription(
				"Discover the machine, erase its disk and install NixOS from the installer.",
			),
		),
		Command.make(
			"destroy",
			{
				name: Argument.String("name").pipe(
					Argument.withDescription("The VM's name, which fleet.ts no longer declares."),
				),
				yes: Flag.Boolean("yes").pipe(
					Flag.withDescription("Delete without asking for the VM's name."),
					Flag.withDefault(false),
				),
			},
			({ name, yes }) => Effect.flatMap(fleet, (root) => destroy(root, name, { yes })),
		).pipe(
			Command.withDescription(
				"Delete a VM that fleet.ts no longer declares: its volume on its host, its secrets and its state.",
			),
		),
	]),
);

/** The aett command line; `aett` is the running package, which new fleets depend on. */
export const command = (aett: AettPackage) =>
	Command.make("aett").pipe(
		Command.withDescription("Manage macOS and NixOS fleets."),
		Command.withSubcommands([
			Command.make(
				"create",
				{
					name: Argument.String("name").pipe(
						Argument.withDescription(
							"The fleet's name, which is also its new directory. aett asks when it is missing.",
						),
						Argument.optional,
					),
					sshKey: Flag.String("ssh-key").pipe(
						Flag.withDescription(
							"The operator's OpenSSH public key, as a key line or a .pub file. Defaults to a key from the SSH agent.",
						),
						Flag.optional,
					),
					machines: Flag.String("machine").pipe(
						Flag.withDescription(
							"A first machine as name:role, or name:role:encrypted for an encrypted disk. Repeat it for more; aett asks when there is none.",
						),
						Flag.filterMap(
							parseMachineFlag,
							() =>
								"Expected name:role or name:role:encrypted, with role hypervisor, server or computer",
						),
						Flag.atLeast(0),
					),
					noMachines: Flag.Boolean("no-machines").pipe(
						Flag.withDescription("Start with no machines instead of asking for them."),
						Flag.withDefault(false),
					),
					packageManager: Flag.Literals("package-manager", PackageManager.literals).pipe(
						Flag.withDescription(
							"Install aett with npm or pnpm. Defaults to the package manager that started aett, else npm.",
						),
						Flag.optional,
					),
				},
				(options) => Effect.flatMap(cwd, (directory) => create(directory, aett, options)),
			).pipe(
				Command.withDescription(
					"Start a fleet in a new directory: keys, first machines, Git and aett installed.",
				),
			),
			Command.make("compile", {}, () => Effect.flatMap(fleet, compile)).pipe(
				Command.withDescription(
					"Write .aett/build/ from fleet.ts and state, and evaluate the machines it lists.",
				),
			),
			Command.make(
				"apply",
				{
					name: Argument.String("name").pipe(
						Argument.withDescription(
							"The machine's name in fleet.ts. Defaults to every installed machine.",
						),
						Argument.optional,
					),
					host: hostFlag(
						"The named bare-metal machine as host[:port]. Defaults to <name>.local.",
					).pipe(Flag.optional),
					yes: Flag.Boolean("yes").pipe(
						Flag.withDescription("Switch without asking."),
						Flag.withDefault(false),
					),
				},
				({ name, ...options }) => Effect.flatMap(fleet, (root) => apply(root, name, options)),
			).pipe(
				Command.withDescription(
					"Build the declared system on installed machines and their VMs and switch to it.",
				),
			),
			machine,
		]),
	);
