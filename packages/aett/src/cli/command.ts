import { Effect, Path } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { installerHost, parseHost } from "../domain/host.ts";
import { apply } from "../workflows/apply.ts";
import { compile } from "../workflows/compile.ts";
import { type AettPackage, init } from "../workflows/init.ts";
import { discover, install } from "../workflows/install.ts";

// Every command works on the fleet in the current directory.
const fleetRoot = Effect.map(Effect.service(Path.Path), (path) => path.resolve());

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
	Command.withDescription("Discover and install machines."),
	Command.withSubcommands([
		Command.make("discover", { name: machineName, ...installerFlags }, ({ name, ...access }) =>
			Effect.flatMap(fleetRoot, (root) => discover(root, name, access)),
		).pipe(
			Command.withDescription("Save the installer's hardware report as state/<name>/facter.json."),
		),
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
						"Install a machine state marks installed again, on its recorded disk.",
					),
					Flag.withDefault(false),
				),
			},
			({ name, ...options }) => Effect.flatMap(fleetRoot, (root) => install(root, name, options)),
		).pipe(
			Command.withDescription(
				"Discover the machine, erase its disk and install NixOS from the installer.",
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
				"init",
				{
					sshKey: Flag.String("ssh-key").pipe(
						Flag.withDescription(
							"The operator's OpenSSH public key, as a key line or a .pub file. Defaults to a key from the SSH agent.",
						),
						Flag.optional,
					),
				},
				({ sshKey }) => Effect.flatMap(fleetRoot, (root) => init(root, aett, sshKey)),
			).pipe(Command.withDescription("Start a fleet in the current directory.")),
			Command.make("compile", {}, () => Effect.flatMap(fleetRoot, compile)).pipe(
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
					host: hostFlag("The named machine as host[:port]. Defaults to <name>.local.").pipe(
						Flag.optional,
					),
					yes: Flag.Boolean("yes").pipe(
						Flag.withDescription("Switch without asking."),
						Flag.withDefault(false),
					),
				},
				({ name, ...options }) => Effect.flatMap(fleetRoot, (root) => apply(root, name, options)),
			).pipe(
				Command.withDescription(
					"Build the declared system on installed machines and switch to it.",
				),
			),
			machine,
		]),
	);
