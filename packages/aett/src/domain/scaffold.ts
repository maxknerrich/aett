import { Option, Result, Schema } from "effect";
import { MachineName, Role } from "./fleet.ts";
import { shippedPlugins } from "./shipped.ts";

/** A fleet's name: its directory and its package name, so lowercase and URL-safe. */
export const FleetName = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/, {
		expected: "a lowercase name of letters, digits, dots, dashes and underscores",
	}),
);

/** A first machine `aett create` writes into fleet.ts. */
export interface NewMachine {
	readonly name: string;
	readonly role: Role;
	/** A Mac; only a computer can be one. */
	readonly mac: boolean;
	/** Its disk inside LUKS; a Mac has no such setting. */
	readonly encrypted: boolean;
}

/** The roles `aett create` offers, with what each means. */
export const roles: ReadonlyArray<{ readonly role: Role; readonly description: string }> = [
	{ role: "hypervisor", description: "Only runs VMs, like Proxmox" },
	{ role: "nas", description: "Storage with mirrored disks that runs services and VMs" },
	{ role: "server", description: "A headless machine you reach over SSH" },
	{ role: "computer", description: "A machine you sit in front of, such as a Mac or a laptop" },
];

const isMachineName = (name: string) =>
	Option.isSome(Schema.decodeUnknownOption(MachineName)(name));

/**
 * Reads `--machine name:role`, `name:role:encrypted` or `name:computer:macos`,
 * the flag for create's machine questions.
 */
export const parseMachineFlag = (value: string): Option.Option<NewMachine> => {
	const [name = "", declared = "", extra, ...rest] = value.split(":");
	const role = Schema.decodeUnknownOption(Role)(declared);

	if (rest.length > 0 || !isMachineName(name) || Option.isNone(role)) return Option.none();

	if (extra === undefined)
		return Option.some({ name, role: role.value, mac: false, encrypted: false });

	if (extra === "encrypted")
		return Option.some({ name, role: role.value, mac: false, encrypted: true });

	return extra === "macos" && role.value === "computer"
		? Option.some({ name, role: role.value, mac: true, encrypted: false })
		: Option.none();
};

// A name as an object key in fleet.ts: quoted when it has a hyphen.
const key = (name: string) => (/^[a-z][a-z0-9]*$/.test(name) ? name : JSON.stringify(name));

// One machine's entry in fleet.ts: its key and its role's call.
const entry = ({ name, role, mac, encrypted }: NewMachine) => {
	const config = mac
		? '{ os: "macos" }'
		: encrypted && role !== "nas"
			? "{ system: { encrypted: true } }"
			: "";

	return `\t\t${key(name)}: ${role}(${config}),\n`;
};

/** What create adopts from the Mac it runs on: the casks Homebrew has there, and the formulae installed on request. */
export interface Adopted {
	readonly mac: string;
	readonly apps: ReadonlyArray<string>;
	readonly brews: ReadonlyArray<string>;
}

// The pack a Mac's adopted apps go into: named after the Mac, unless that name is aett's own.
const packName = (mac: string) =>
	mac === "default" || shippedPlugins.some(({ name }) => name === mac) ? "apps" : mac;

/**
 * Renders fleet.ts for what create was given: the user, the first machines,
 * and the apps of the Mac it runs on, in a pack named after the Mac, whose
 * dotfiles/<mac>/ then holds that Mac's own dotfiles.
 */
export const fleetSource = (
	user: string,
	machines: ReadonlyArray<NewMachine>,
	adopted: Option.Option<Adopted>,
) => {
	const imports = [...new Set(["fleet", ...machines.map(({ role }) => role)])].toSorted();

	const services = Option.match(adopted, {
		onNone: () => "",
		// Casks come first on a Mac anyway; formulae are led by brew., so none turns into a cask or a Nix package.
		onSome: ({ mac, apps, brews }) =>
			`\tservices: {\n\t\t${key(packName(mac))}: { on: ${JSON.stringify(mac)}, packages: [${[...apps, ...brews.map((brew) => `brew.${brew}`)].map((name) => JSON.stringify(name)).join(", ")}] },\n\t},\n`,
	});

	return `import { ${imports.join(", ")} } from "aett"\n\nexport default fleet({\n\tuser: ${JSON.stringify(user)},\n\tmachines: {${machines.length === 0 ? "" : `\n${machines.map(entry).join("")}\t`}},\n${services}})\n`;
};

/** A name the list uses twice, which a fleet can't have. */
export const duplicateName = (machines: ReadonlyArray<NewMachine>) =>
	Option.fromUndefinedOr(
		machines.find(({ name }, index) => machines.findIndex((other) => other.name === name) < index)
			?.name,
	);

export const PackageManager = Schema.Literals(["npm", "pnpm"]);

export type PackageManager = typeof PackageManager.Type;

/**
 * The package manager that started aett, read from npm_config_user_agent
 * (`pnpm/10.0.0 npm/? node/…`), when it is npm or pnpm. npm, which ships with
 * Node, otherwise.
 */
export const packageManager = (userAgent: Option.Option<string>): PackageManager =>
	userAgent.pipe(
		Option.flatMap((agent) => Schema.decodeUnknownOption(PackageManager)(agent.split("/")[0])),
		Option.getOrElse(() => "npm" as const),
	);

/** Whether `name` can join `machines`: a valid machine name not taken yet. */
export const newMachineName = (machines: ReadonlyArray<NewMachine>, name: string) => {
	if (!isMachineName(name)) {
		return Result.fail("Expected a lowercase hostname: a-z, 0-9 and inner hyphens");
	}

	return machines.some((machine) => machine.name === name)
		? Result.fail(`${name} is already in the fleet`)
		: Result.succeed(name);
};

/**
 * How a new fleet depends on aett: by version when aett came from the
 * registry, else on the source checkout it runs from. npm links a `file:`
 * directory; pnpm would install the checkout's own `catalog:` dependencies
 * from it, so it gets `link:`.
 */
export const aettDependency = (
	manager: PackageManager,
	checkout: Option.Option<string>,
	version: string,
) =>
	Option.match(checkout, {
		onNone: () => `^${version}`,
		onSome: (directory) => `${manager === "npm" ? "file" : "link"}:${directory}`,
	});
