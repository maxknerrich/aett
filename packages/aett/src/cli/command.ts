import { Effect, Path, Redacted } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { installerHost, parseHost } from "../domain/host.ts";
import { PackageManager, parseMachineFlag } from "../domain/scaffold.ts";
import { apply } from "../workflows/apply.ts";
import { compile } from "../workflows/compile.ts";
import { type AettPackage, create } from "../workflows/create.ts";
import { destroy } from "../workflows/destroy.ts";
import { fleetRoot } from "../workflows/load.ts";
import { update } from "../workflows/pins.ts";
import { setSecret } from "../workflows/secrets.ts";
import { show } from "../workflows/show.ts";
import { status } from "../workflows/status.ts";
import { setupTailscale } from "../workflows/tailscale.ts";
import { unlock } from "../workflows/unlock.ts";
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
				rootDisks: Flag.String("root-disk").pipe(
					Flag.withDescription(
						"A NAS: a disk of its root pool, by any of its /dev names. Repeat it for each; aett asks when there is none.",
					),
					Flag.atLeast(0),
				),
				tankDisks: Flag.String("tank-disk").pipe(
					Flag.withDescription(
						"A NAS: a disk of its tank pool, by any of its /dev names. Repeat it for each; aett asks when there is none.",
					),
					Flag.atLeast(0),
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
		Command.make("unlock", { name: machineName }, ({ name }) =>
			Effect.flatMap(fleet, (root) => unlock(root, name)),
		).pipe(
			Command.withDescription(
				"Open an encrypted machine waiting at boot: send its disk passphrase to its initrd over the tailnet.",
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
				"Delete a VM that fleet.ts no longer declares: its volume on its host, its secrets and its state. You remove its node in the Tailscale admin console.",
			),
		),
	]),
);

const tailscale = Command.make("tailscale").pipe(
	Command.withDescription("Connect the fleet to your tailnet."),
	Command.withSubcommands([
		Command.make("setup", {}, () => Effect.flatMap(fleet, setupTailscale)).pipe(
			Command.withDescription(
				"Say what the tailnet's policy needs, or store the OAuth client that lets aett add it.",
			),
		),
	]),
);

const secret = Command.make("secret").pipe(
	Command.withDescription("Set the secrets machines read."),
	Command.withSubcommands([
		Command.make(
			"set",
			{
				name: Argument.String("name").pipe(
					Argument.withDescription("The secret, such as users/<name>."),
				),
			},
			({ name }) => Effect.flatMap(fleet, (root) => setSecret(root, name)),
		).pipe(
			Command.withDescription(
				"Ask for a secret and store it encrypted to the operators and the machines that read it.",
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
					user: Flag.String("user").pipe(
						Flag.withDescription(
							"The fleet's user, your login name on its machines. aett asks when it is missing.",
						),
						Flag.optional,
					),
					keychain: Flag.Boolean("no-keychain").pipe(
						Flag.withDescription("On a Mac, don't keep the age key in the login keychain."),
						Flag.map((no) => !no),
						Flag.withDefault(true),
					),
					showKey: Flag.Boolean("show-key").pipe(
						Flag.withDescription(
							"Print the age key instead of putting it on the clipboard, such as in an SSH session.",
						),
						Flag.withDefault(false),
					),
					sshKey: Flag.String("ssh-key").pipe(
						Flag.withDescription(
							"The operator's OpenSSH public key, as a key line or a .pub file. Defaults to a key from the SSH agent.",
						),
						Flag.optional,
					),
					machines: Flag.String("machine").pipe(
						Flag.withDescription(
							"A first machine as name:role, name:role:encrypted for an encrypted disk, or name:computer:macos. Repeat it for more; aett asks when there is none.",
						),
						Flag.filterMap(
							parseMachineFlag,
							() =>
								"Expected name:role, name:role:encrypted or name:computer:macos, with role hypervisor, nas, server or computer",
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
			Command.make("show", {}, () => Effect.flatMap(fleet, show)).pipe(
				Command.withDescription(
					"Print the fleet by machine: what each is, its services, packages, apps and home trees.",
				),
			),
			Command.make(
				"apply",
				{
					name: Argument.String("name").pipe(
						Argument.withDescription(
							"The machine's name in fleet.ts. Defaults to every installed machine, and the Mac aett runs on.",
						),
						Argument.optional,
					),
					yes: Flag.Boolean("yes").pipe(
						Flag.withDescription("Switch without asking."),
						Flag.withDefault(false),
					),
				},
				({ name, ...options }) => Effect.flatMap(fleet, (root) => apply(root, name, options)),
			).pipe(
				Command.withDescription(
					"Build the declared system on installed machines, their VMs and this Mac, and switch to it.",
				),
			),
			Command.make("status", {}, () => Effect.flatMap(fleet, status)).pipe(
				Command.withDescription(
					"Ask every machine how it is reached, its tailnet address, whether it runs what fleet.ts builds, and how its guests are.",
				),
			),
			Command.make(
				"update",
				{
					names: Argument.String("name").pipe(
						Argument.withDescription(
							"An input such as nixpkgs, or a release source by repository or binary. Defaults to every pin.",
						),
						Argument.atLeast(0),
					),
				},
				({ names }) => Effect.flatMap(fleet, (root) => update(root, names)),
			).pipe(
				Command.withDescription(
					"Move the fleet's pins in state/pins.json forward and print what changes. On a Mac in the fleet, upgrade its apps too.",
				),
			),
			machine,
			tailscale,
			secret,
		]),
	);
