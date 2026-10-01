import { Option, Result, Schema } from "effect";
import { Machine, MachineName, type Role } from "./fleet.ts";

/** A fleet's name: its directory and its package name, so lowercase and URL-safe. */
export const FleetName = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/, {
		expected: "a lowercase name of letters, digits, dots, dashes and underscores",
	}),
);

/** The roles `aett create` offers, with what each means today. */
export const roles: ReadonlyArray<{ readonly role: Role; readonly description: string }> = [
	{ role: "hypervisor", description: "Hosts VMs later; ignores the laptop lid" },
	{ role: "server", description: "Runs services; ignores the laptop lid" },
	{ role: "computer", description: "A machine you work on" },
];

const decodeMachine = Schema.decodeUnknownOption(Machine);

/**
 * Reads `--machine name:role[:encrypted]`, the flag for create's machine
 * questions, into a machine declaration.
 */
export const parseMachineFlag = (value: string): Option.Option<Machine> => {
	const [name, role, encrypted, ...rest] = value.split(":");

	if (rest.length > 0 || (encrypted !== undefined && encrypted !== "encrypted")) {
		return Option.none();
	}

	return decodeMachine(
		encrypted === undefined ? { name, role } : { name, role, disk: { encrypted: true } },
	);
};

/** Renders fleet.ts for the machines create was given. */
export const fleetSource = (machines: ReadonlyArray<Machine>) => {
	const declared = machines.map(
		({ name, role, disk }) =>
			`\t\tmachine(${JSON.stringify(name)}, { role: ${JSON.stringify(role)}${disk?.encrypted === true ? ", disk: { encrypted: true }" : ""} }),\n`,
	);

	return machines.length === 0
		? 'import { fleet } from "aett"\n\nexport default fleet({\n\tmachines: [],\n})\n'
		: `import { fleet, machine } from "aett"\n\nexport default fleet({\n\tmachines: [\n${declared.join("")}\t],\n})\n`;
};

const PackageManager = Schema.Literals(["npm", "pnpm", "yarn", "bun"]);

export type PackageManager = typeof PackageManager.Type;

/**
 * The package manager that started aett, read from npm_config_user_agent
 * (`pnpm/10.0.0 npm/? node/…`). npm, which ships with Node, otherwise.
 */
export const packageManager = (userAgent: Option.Option<string>): PackageManager =>
	userAgent.pipe(
		Option.flatMap((agent) => Schema.decodeUnknownOption(PackageManager)(agent.split("/")[0])),
		Option.getOrElse(() => "npm" as const),
	);

/** Whether `name` can join `machines`: a valid machine name not taken yet. */
export const newMachineName = (machines: ReadonlyArray<Machine>, name: string) =>
	Schema.is(MachineName)(name)
		? machines.some((machine) => machine.name === name)
			? Result.fail(`${name} is already in the fleet`)
			: Result.succeed(name)
		: Result.fail("Expected a lowercase hostname: a-z, 0-9 and inner hyphens");
