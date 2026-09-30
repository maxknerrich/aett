import { Effect, Path } from "effect";
import { Command, Flag } from "effect/cli";
import { compile } from "../workflows/compile.ts";
import { type AettPackage, init } from "../workflows/init.ts";

// Every command works on the fleet in the current directory.
const fleetRoot = Effect.map(Effect.service(Path.Path), (path) => path.resolve());

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
		]),
	);
