import { Match, Option, Predicate, Result, Schema, SchemaIssue } from "effect";
import { explicitSource, Package, type Release, splitPackages } from "./packages.ts";
import type { Plugin, Role as PluginRole } from "./plugin.ts";
import { machineSecrets } from "./secrets.ts";
import { shippedPlugins as shipped } from "./shipped.ts";

export const MachineName = Schema.String.check(
	Schema.isPattern(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, {
		expected: "a lowercase hostname label (a-z, 0-9 and inner hyphens, at most 63 characters)",
	}),
	// A machine keeps its secrets in secrets/<name>/, next to the user's and the plugins'.
	Schema.makeFilter(
		(name: string) =>
			!["users", "services"].includes(name) ||
			`Expected another name: aett keeps the fleet's ${name} secrets in secrets/${name}/`,
	),
);

/** hypervisor: an appliance that only runs VMs; nas: storage that runs services and VMs; server: headless, reached over SSH; computer: graphical, used in person. */
export const Role = Schema.Literals(["hypervisor", "nas", "server", "computer"]);

export type Role = PluginRole;

/** stable is the NixOS release aett pins; unstable opts a machine into nixos-unstable. */
export const Channel = Schema.Literals(["stable", "unstable"]);

export type Channel = typeof Channel.Type;

/** A size such as "32 GiB": a number and a binary unit. */
export const Size = Schema.String.check(
	Schema.isPattern(/^\d+(\.\d+)? (MiB|GiB|TiB)$/, { expected: 'a size such as "32 GiB"' }),
);

const units = new Map([
	["MiB", 2 ** 20],
	["GiB", 2 ** 30],
	["TiB", 2 ** 40],
]);

/** A size's bytes. */
export const bytes = (size: string) => {
	const [amount = "0", unit = ""] = size.split(" ");

	return Number(amount) * (units.get(unit) ?? 0);
};

// A size no smaller than `minimum`.
const atLeast = (minimum: string) =>
	Size.check(
		Schema.makeFilter(
			(size: string) => bytes(size) >= bytes(minimum) || `Expected at least ${minimum}`,
		),
	);

const NixosSystem = Schema.Struct({
	encrypted: Schema.optionalKey(Schema.Boolean),
	channel: Schema.optionalKey(Channel),
});

const VmSystem = Schema.Struct({
	cpu: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	memory: Schema.optionalKey(atLeast("512 MiB")),
	disk: Schema.optionalKey(atLeast("1 GiB")),
	channel: Schema.optionalKey(Channel),
});

// One shape per kind of machine; which applies follows from its role, host and os.
const Hypervisor = Schema.Struct({
	role: Schema.Literal("hypervisor"),
	os: Schema.optionalKey(Schema.Literal("nixos")),
	system: Schema.optionalKey(NixosSystem),
});

const Nas = Schema.Struct({
	role: Schema.Literal("nas"),
	os: Schema.optionalKey(Schema.Literal("nixos")),
	system: Schema.optionalKey(Schema.Struct({ channel: Schema.optionalKey(Channel) })),
});

const Server = Schema.Struct({
	role: Schema.Literal("server"),
	os: Schema.optionalKey(Schema.Literal("nixos")),
	system: Schema.optionalKey(NixosSystem),
});

const Vm = Schema.Struct({
	role: Schema.Literal("server"),
	host: MachineName,
	system: Schema.optionalKey(VmSystem),
});

const Computer = Schema.Struct({
	role: Schema.Literal("computer"),
	os: Schema.optionalKey(Schema.Literal("nixos")),
	system: Schema.optionalKey(
		Schema.Struct({ ...NixosSystem.fields, desktop: Schema.optionalKey(Schema.NonEmptyString) }),
	),
});

const Mac = Schema.Struct({
	role: Schema.Literal("computer"),
	os: Schema.Literal("macos"),
	// No settings yet; a record of nothing rejects every key, where an empty struct would not.
	system: Schema.optionalKey(Schema.Record(Schema.String, Schema.Never)),
});

// Enough of a declared machine to tell which shape it must have.
const Declared = Schema.StructWithRest(
	Schema.Struct({
		role: Role,
		host: Schema.optionalKey(Schema.Unknown),
		os: Schema.optionalKey(Schema.Unknown),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
);

/**
 * What fleet.ts must default-export before its machines and services are
 * checked. Other keys pass through so that decodeFleet can reject them.
 */
export const Declaration = Schema.StructWithRest(
	Schema.Struct({ machines: Schema.Record(Schema.String, Schema.Unknown) }),
	[Schema.Record(Schema.String, Schema.Unknown)],
);

export interface Declaration extends Schema.Schema.Type<typeof Declaration> {}

/** A user's login name, which NixOS and macOS take: lowercase, shorter than 32 characters, and not root. */
export const UserName = Schema.String.check(
	Schema.isPattern(/^[a-z_][a-z0-9_-]{0,30}$/, {
		expected: "a lowercase login name of at most 31 characters",
	}),
	Schema.makeFilter(
		(name: string) => name !== "root" || "Expected a user other than root, which aett keeps locked",
	),
);

/** An entry's name in `services`, which home/<name>/ follows. "default" names the home tree every machine gets. */
export const EntryName = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/, {
		expected: "a lowercase name: a-z, 0-9, dots, dashes and underscores",
	}),
	Schema.makeFilter(
		(name: string) =>
			name !== "default" || "Expected another name: home/default/ goes to every machine already",
	),
);

const Top = Schema.Struct({
	user: Schema.optionalKey(UserName),
	machines: Schema.Record(Schema.String, Schema.Unknown),
	services: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	plugins: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

// What aett checks of a plugin from `plugins`: the rest is read where it is used.
const PluginMetadata = Schema.Struct({
	name: EntryName,
	options: Schema.optionalKey(
		Schema.declare((input): input is Schema.Decoder<unknown> => Schema.isSchema(input), {
			expected: "a Schema, such as Schema.Struct({…})",
		}),
	),
	directory: Schema.optionalKey(Schema.Union([Schema.String, Schema.instanceOf(URL)])),
	package: Schema.optionalKey(Schema.String),
	endpoints: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({
				port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
				web: Schema.optionalKey(Schema.Boolean),
			}),
		),
	),
	secrets: Schema.optionalKey(
		Schema.Record(
			// One component of a path and of the name sops-nix gives it.
			Schema.String.check(
				Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/, {
					expected: "a secret's name: a-z, 0-9 and dashes",
				}),
			),
			Schema.Union([
				Schema.Struct({
					generate: Schema.Literals(["password", "certificate"]),
					per: Schema.optionalKey(Schema.Literals(["fleet", "instance", "client"])),
				}),
				Schema.Struct({
					prompt: Schema.NonEmptyString,
					per: Schema.optionalKey(Schema.Literals(["fleet", "instance", "client"])),
				}),
			]),
		),
	),
	state: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Struct({ bulk: Schema.optionalKey(Schema.Boolean) })),
	),
	health: Schema.optionalKey(Schema.String),
	roles: Schema.optionalKey(Schema.Array(Role)),
	systems: Schema.optionalKey(Schema.Array(Schema.Literals(["nixos", "darwin"]))),
	single: Schema.optionalKey(Schema.Boolean),
	always: Schema.optionalKey(Schema.Boolean),
	clients: Schema.optionalKey(Schema.Boolean),
});

// The keys every entry takes; the rest are a plugin's options.
const EntryBase = Schema.Struct({
	on: Schema.optionalKey(Schema.Union([MachineName, Schema.Array(MachineName)])),
	packages: Schema.optionalKey(Schema.Array(Package)),
});

export type Kind = "nixos" | "macos" | "vm";

/** Where a VM runs and its size, with the defaults filled in. Sizes are whole MiB. */
export interface VmSettings {
	/** The hypervisor, NAS or bare-metal server that builds and runs it. */
	readonly host: string;
	readonly cpu: number;
	readonly memory: number;
	/** Its state volume's size. */
	readonly disk: number;
}

/** A plugin on one machine: as an instance, or as a client of the instances. */
export interface Placement {
	readonly name: string;
	readonly instance: boolean;
}

/** A plugin as the fleet places it: its options and the machines it configures. */
export interface Service {
	readonly plugin: Plugin;
	/** The entry's options, as the plugin's schema decoded them. */
	readonly options: unknown;
	readonly instances: ReadonlyArray<string>;
	/** Machines it configures as clients of the instances. */
	readonly clients: ReadonlyArray<string>;
}

/** A machine as aett works with it: what fleet.ts declares, with its entries resolved. */
export interface Machine {
	readonly name: string;
	readonly role: Role;
	/** Bare-metal NixOS, a Mac, or a VM; only bare-metal NixOS comes from the installer. */
	readonly kind: Kind;
	/** Inside LUKS: an encrypted bare-metal machine, and every NAS. */
	readonly encrypted: boolean;
	readonly channel: Channel;
	/** Set exactly for a VM. */
	readonly vm: Option.Option<VmSettings>;
	/** Whether it has the fleet's user and a home: every machine but a hypervisor. */
	readonly user: boolean;
	/** Package names, each from the source the fleet's pins record. */
	readonly packages: ReadonlyArray<string>;
	/** Packages from GitHub releases, one per repository. */
	readonly releases: ReadonlyArray<Release>;
	/** The plugins on it, by name. */
	readonly services: ReadonlyArray<Placement>;
	/** The trees under home/ that land in its home: default, then each entry it is on. */
	readonly home: ReadonlyArray<string>;
	/** What it declares that aett can't build yet; install and apply refuse it while there is any. */
	readonly unsupported: ReadonlyArray<string>;
}

export interface Fleet {
	/** The fleet's one user, whom every machine but a hypervisor has. */
	readonly user: Option.Option<string>;
	readonly machines: ReadonlyArray<Machine>;
	/** Every plugin some machine has, by name. */
	readonly services: ReadonlyMap<string, Service>;
	/** The fleet's own plugins, which aett copies into the build. */
	readonly plugins: ReadonlyArray<Plugin>;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

// Decodes `input` with `schema`, rejecting unknown keys. A failure holds one line per problem, prefixed with where it is.
const decodeAt = <S extends Schema.Decoder<unknown>>(
	schema: S,
	input: Declaration["machines"][string],
	at: string,
) =>
	Schema.decodeUnknownResult(schema)(input, {
		errors: "all",
		reportInput: true,
		onExcessProperty: "error",
	}).pipe(
		Result.mapError((error) =>
			formatIssue(error.issue).issues.map(({ path = [], message }) => {
				const keys = path.filter((key) => Predicate.isString(key) || Predicate.isNumber(key));

				return `${[at, ...keys].join(".")}: ${message}`;
			}),
		),
	);

/** A machine as declared, after its shape was checked: what it is, where it runs and its settings. */
interface Decoded {
	readonly name: string;
	readonly role: Role;
	readonly kind: Kind;
	readonly host: string | undefined;
	readonly system: {
		readonly encrypted?: boolean;
		readonly channel?: Channel;
		readonly desktop?: string;
		readonly cpu?: number;
		readonly memory?: string;
		readonly disk?: string;
	};
}

// The schema a declared machine must match, which follows from its role, whether it has a host and its os.
const declarationFor = (role: Role, vm: boolean, macos: boolean) => {
	if (role === "hypervisor") return Hypervisor;

	if (role === "nas") return Nas;

	if (role === "computer") return macos ? Mac : Computer;

	return vm ? Vm : Server;
};

// Checks a declared machine against the shape for what it is.
const decodeMachine = (
	name: string,
	input: Declaration["machines"][string],
): Result.Result<Decoded, ReadonlyArray<string>> => {
	const at = `machines.${name}`;
	const declared = decodeAt(Declared, input, at);

	if (Result.isFailure(declared)) {
		return Result.fail([`${at}: Expected hypervisor(…), nas(…), server(…) or computer(…)`]);
	}

	const { role, host, os } = declared.success;

	if (role !== "server" && host !== undefined) {
		return Result.fail([`${at}.host: Only a server can be a VM; a ${role} runs on bare metal`]);
	}

	if (host !== undefined && os !== undefined) {
		return Result.fail([`${at}: A VM has a host or an os, not both; its os is always NixOS`]);
	}

	const vm = host !== undefined;
	const macos = os === "macos";

	return decodeAt(declarationFor(role, vm, macos), input, at).pipe(
		Result.map((machine) => ({
			name,
			role,
			kind: vm ? "vm" : macos ? "macos" : "nixos",
			host: "host" in machine ? machine.host : undefined,
			system: machine.system ?? {},
		})),
	);
};

// Every problem a list of decode results holds.
const failures = <A>(results: ReadonlyArray<Result.Result<A, ReadonlyArray<string>>>) =>
	results.flatMap((result) => (Result.isFailure(result) ? result.failure : []));

// The successes of a list of decode results.
const successes = <A>(results: ReadonlyArray<Result.Result<A, ReadonlyArray<string>>>) =>
	results.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []));

/** One entry of `services`, decoded: the plugin it names, if any, and its parts. */
interface Entry {
	readonly name: string;
	readonly plugin: Option.Option<Plugin>;
	/** The machines named in `on`; none means every machine it can be on. */
	readonly on: Option.Option<ReadonlyArray<string>>;
	readonly packages: ReadonlyArray<Package>;
	readonly options: unknown;
}

// An entry given as a machine or a list of machines is the object with only `on`.
const asObject = (value: Declaration["machines"][string]) =>
	Predicate.isString(value) || Array.isArray(value) ? { on: value } : value;

// Decodes one entry: the keys every entry has, then the rest with the plugin's options, if it names one.
const decodeEntry = (
	name: string,
	value: Declaration["machines"][string],
	plugins: ReadonlyMap<string, Plugin>,
): Result.Result<Entry, ReadonlyArray<string>> => {
	const at = `services.${name}`;
	const plugin = Option.fromUndefinedOr(plugins.get(name));

	if (Option.exists(plugin, ({ always }) => always === true)) {
		return Result.fail([`${at}: ${name} is on every machine already and takes no entry`]);
	}

	const named = decodeAt(EntryName, name, `services`);

	if (Result.isFailure(named)) return Result.fail([`${at}: ${named.failure.join("; ")}`]);

	const object = asObject(value);

	if (!Predicate.isObject(object)) {
		return Result.fail([`${at}: Expected a machine, a list of machines or an entry`]);
	}

	// The keys every entry takes go to EntryBase, the rest to the plugin's options.
	const common = (key: string) => key in EntryBase.fields;
	const entries = Object.entries(object);
	const base = decodeAt(EntryBase, Object.fromEntries(entries.filter(([key]) => common(key))), at);
	const rest = Object.fromEntries(entries.filter(([key]) => !common(key)));

	// A pack, or a plugin without options, takes no other keys.
	const options = Option.match(
		Option.flatMapNullishOr(plugin, ({ options: schema }) => schema),
		{
			onNone: () => {
				const extra = Object.keys(rest);

				return extra.length === 0
					? Result.succeed({})
					: Result.fail(
							extra.map(
								(key) =>
									`${at}.${key}: Unexpected key; ${Option.isNone(plugin) ? "a pack" : name} takes on and packages`,
							),
						);
			},
			onSome: (schema) => decodeAt(schema, rest, at),
		},
	);

	const problems = [...failures([base]), ...failures([options])];

	if (Result.isFailure(base) || Result.isFailure(options) || problems.length > 0) {
		return Result.fail(problems);
	}

	const decoded = base.success;

	return Result.succeed({
		name,
		plugin,
		on: Option.map(Option.fromUndefinedOr(decoded.on), (given) =>
			Predicate.isString(given) ? [given] : given,
		),
		packages: decoded.packages ?? [],
		options: options.success,
	});
};

// The system a machine's modules are for.
const systemOf = (machine: Decoded) => (machine.kind === "macos" ? "darwin" : "nixos");

// What a machine is, as an error names it: a Mac, a VM or its role.
const describeKind = (machine: Decoded) =>
	Match.value(machine.kind).pipe(
		Match.when("macos", () => "a Mac"),
		Match.when("vm", () => "a VM"),
		Match.orElse(() => `a ${machine.role}`),
	);

// Where an entry is, or why it can't be there: the machines in `on`, else every machine it can be on.
const placeEntry = (
	entry: Entry,
	machines: ReadonlyArray<Decoded>,
): Result.Result<ReadonlyArray<string>, ReadonlyArray<string>> => {
	const at = `services.${entry.name}`;

	const fits = (machine: Decoded) =>
		Option.match(entry.plugin, {
			onNone: () => machine.role !== "hypervisor",
			// Caddy serves web endpoints on NixOS only.
			onSome: ({ roles, systems, endpoints }) =>
				(roles ?? Role.literals).includes(machine.role) &&
				(systems ?? ["nixos", "darwin"]).includes(systemOf(machine)) &&
				!(
					systemOf(machine) === "darwin" &&
					Object.values(endpoints ?? {}).some(({ web }) => web === true)
				),
		});

	const named = Option.getOrUndefined(entry.on);

	if (named === undefined) {
		return Option.exists(entry.plugin, ({ single }) => single === true)
			? Result.fail([
					`${at}.on: ${entry.name} has one machine; name it, such as ${entry.name}: "box"`,
				])
			: Result.succeed(machines.flatMap((machine) => (fits(machine) ? [machine.name] : [])));
	}

	const problems = named.flatMap((name) => {
		const machine = machines.find((declared) => declared.name === name);

		if (machine === undefined) return [`${at}.on: There is no machine named "${name}"`];

		if (fits(machine)) return [];

		if (Option.isNone(entry.plugin)) {
			return [`${at}.on: ${name} is a hypervisor, which runs nothing but VMs and services`];
		}

		return [`${at}.on: ${entry.name} can't run on ${name}, which is ${describeKind(machine)}`];
	});

	const single = Option.exists(entry.plugin, (plugin) => plugin.single === true);

	if (single && named.length !== 1) {
		return Result.fail([...problems, `${at}.on: ${entry.name} runs on exactly one machine`]);
	}

	return problems.length > 0 ? Result.fail(problems) : Result.succeed([...new Set(named)]);
};

/**
 * Decodes fleet.ts's default export into a fleet: every machine's shape, each
 * VM's host, each plugin and each entry of `services` and where it is, then
 * each machine with its entries resolved. A failure holds one line per
 * problem, naming where it is.
 */
export const decodeFleet = (declaration: Declaration): Result.Result<Fleet, string> => {
	if ("stacks" in declaration) {
		return Result.fail(
			'fleet(): stacks are gone. Put packages and apps in entries of services, such as services: { dev: { on: ["zeus"], packages: ["git"] } }.',
		);
	}

	const top = decodeAt(Top, declaration, "fleet()");

	if (Result.isFailure(top)) return Result.fail(top.failure.join("\n"));

	const names = Object.keys(top.success.machines);

	const machines = names.map((name): Result.Result<Decoded, ReadonlyArray<string>> =>
		Option.isSome(Schema.decodeUnknownOption(MachineName)(name))
			? decodeMachine(name, top.success.machines[name])
			: Result.fail([
					`machines.${name}: Expected a lowercase hostname label: a-z, 0-9 and inner hyphens`,
				]),
	);

	const ownPlugins = (top.success.plugins ?? []).map(
		(input, index): Result.Result<Plugin, ReadonlyArray<string>> =>
			decodeAt(PluginMetadata, input, `plugins.${index}`),
	);

	const own = successes(ownPlugins);

	const clashes = own.flatMap(({ name }, index) =>
		shipped.some((plugin) => plugin.name === name) ||
		own.findIndex((other) => other.name === name) !== index
			? [`plugins.${index}.name: aett already knows a plugin named ${name}`]
			: [],
	);

	const plugins = new Map<string, Plugin>(
		[...shipped, ...own].map((plugin) => [plugin.name, plugin]),
	);

	const entries = Object.entries(top.success.services ?? {}).map(([name, value]) =>
		decodeEntry(name, value, plugins),
	);

	const declarationProblems = [
		...failures(machines),
		...failures(ownPlugins),
		...clashes,
		...failures(entries),
	];

	if (declarationProblems.length > 0) return Result.fail(declarationProblems.join("\n"));

	const decoded = successes(machines);
	const declared = successes(entries);

	// Plugins that are on every machine without an entry, such as tailscale.
	const always = [...plugins.values()].flatMap((plugin): ReadonlyArray<Entry> =>
		plugin.always === true
			? [
					{
						name: plugin.name,
						plugin: Option.some(plugin),
						on: Option.none(),
						packages: [],
						options: {},
					},
				]
			: [],
	);

	const placed = [...always, ...declared].map((entry) =>
		placeEntry(entry, decoded).pipe(Result.map((on) => ({ entry, on }))),
	);

	const problems = [...hostProblems(decoded), ...failures(placed), ...releaseProblems(declared)];

	if (problems.length > 0) return Result.fail(problems.join("\n"));

	const hasUser = decoded.some(({ role }) => role !== "hypervisor");

	if (top.success.user === undefined && hasUser) {
		return Result.fail(
			`fleet(): user is required, because every machine but a hypervisor has the fleet's user. Name it, such as user: "you".`,
		);
	}

	const services = placeServices(successes(placed), decoded);

	const fleet: Fleet = {
		user: Option.fromUndefinedOr(top.success.user),
		machines: decoded.map((machine) => toMachine(machine, successes(placed), services)),
		services,
		plugins: own,
	};

	// A plugin's secret named like aett's own, such as a plugin users with a secret named after the
	// user, would take the other's place on the machines.
	const secretNames = machineSecrets(fleet).map(({ name }) => name);

	const taken = [
		...new Set(secretNames.filter((name, index) => secretNames.indexOf(name) !== index)),
	];

	return taken.length > 0
		? Result.fail(
				taken
					.map(
						(name) =>
							`services: ${name} is the name of two secrets; rename the plugin or its secret`,
					)
					.join("\n"),
			)
		: Result.succeed(fleet);
};

/** An entry and the machines it is on. */
interface Placed {
	readonly entry: Entry;
	readonly on: ReadonlyArray<string>;
}

// Each plugin with its instances and, for one that has clients, every other machine with the
// user or a service's state on it whose system it has modules for.
const placeServices = (placed: ReadonlyArray<Placed>, machines: ReadonlyArray<Decoded>) => {
	const plugins = placed.flatMap(({ entry, on }) =>
		Option.toArray(Option.map(entry.plugin, (plugin) => ({ plugin, entry, on }))),
	);

	// Machines that keep a service's state: instances of a plugin that declares some.
	const stateful = new Set(
		plugins.flatMap(({ plugin, on }) => (Object.keys(plugin.state ?? {}).length > 0 ? on : [])),
	);

	return new Map(
		plugins.map(({ plugin, entry, on }) => {
			const clients =
				plugin.clients === true
					? machines.flatMap((machine) =>
							!on.includes(machine.name) &&
							(machine.role !== "hypervisor" || stateful.has(machine.name)) &&
							(plugin.systems ?? ["nixos", "darwin"]).includes(systemOf(machine))
								? [machine.name]
								: [],
						)
					: [];

			return [
				plugin.name,
				{ plugin, options: entry.options, instances: on, clients } satisfies Service,
			] as const;
		}),
	);
};

// A repository's release is declared the same way wherever it appears, since aett pins one per repository.
const releaseProblems = (entries: ReadonlyArray<Entry>) => {
	const declared = entries.flatMap(({ name, packages }) =>
		packages.flatMap((tool) => (Predicate.isString(tool) ? [] : [{ entry: name, release: tool }])),
	);

	return [...Map.groupBy(declared, ({ release }) => release.github)].flatMap(([github, uses]) =>
		new Set(uses.map(({ release }) => `${release.asset}\0${release.bin}`)).size > 1
			? [
					`services: ${github} is released with different asset or bin in ${[...new Set(uses.map(({ entry }) => entry))].join(" and ")}; declare it once and share it.`,
				]
			: [],
	);
};

// Each VM's host must be a hypervisor, a NAS or a bare-metal server.
const hostProblems = (machines: ReadonlyArray<Decoded>) =>
	machines.flatMap((machine) => {
		if (machine.host === undefined) return [];

		const host = machines.find(({ name }) => name === machine.host);

		if (host === undefined)
			return [`machines.${machine.name}.host: There is no machine named "${machine.host}"`];

		return host.role === "hypervisor" ||
			host.role === "nas" ||
			(host.role === "server" && host.kind === "nixos")
			? []
			: [
					`machines.${machine.name}.host: ${machine.host} is a ${host.kind === "vm" ? "VM" : host.role}; a VM runs on a hypervisor, a NAS or a bare-metal server`,
				];
	});

// The machine aett works with: its settings, what its entries bring and what aett can't build yet.
const toMachine = (
	machine: Decoded,
	placed: ReadonlyArray<Placed>,
	services: ReadonlyMap<string, Service>,
): Machine => {
	const mine = placed.flatMap(({ on, entry }) => (on.includes(machine.name) ? [entry] : []));
	const { names, releases } = splitPackages(mine.flatMap(({ packages }) => packages));

	const user = machine.role !== "hypervisor";
	const { system } = machine;

	const unsupported = [system.desktop === undefined ? [] : ["desktops"]].flat();

	const placements = [...services].flatMap(([name, service]) => {
		if (service.instances.includes(machine.name)) return [{ name, instance: true }];

		return service.clients.includes(machine.name) ? [{ name, instance: false }] : [];
	});

	// Each plugin on it brings its package, which its modules run and the operator can use there.
	const pluginPackages = placements.flatMap(({ name }) =>
		Option.toArray(Option.fromUndefinedOr(services.get(name)?.plugin.package)),
	);

	return {
		name: machine.name,
		role: machine.role,
		kind: machine.kind,
		encrypted: machine.role === "nas" || system.encrypted === true,
		channel: system.channel ?? "stable",
		vm: Option.map(Option.fromUndefinedOr(machine.host), (host) => ({
			host,
			cpu: system.cpu ?? 2,
			memory: mebibytes(system.memory ?? "2 GiB"),
			disk: mebibytes(system.disk ?? "20 GiB"),
		})),
		user,
		// Homebrew's reach only Macs.
		packages: [...new Set([...names, ...pluginPackages])]
			.filter(
				(name) =>
					machine.kind === "macos" ||
					!Option.exists(
						explicitSource(name),
						({ source }) => source === "cask" || source === "brew",
					),
			)
			.toSorted(),
		releases,
		services: placements,
		// Plugins on every machine have no entry, so no home tree follows them.
		home: user
			? [
					"default",
					...mine
						.flatMap(({ name, plugin }) =>
							Option.exists(plugin, ({ always }) => always === true) ? [] : [name],
						)
						.toSorted(),
				]
			: [],
		unsupported,
	};
};

// A size in whole MiB, which is what the VM engine takes.
const mebibytes = (size: string) => Math.floor(bytes(size) / 2 ** 20);

/** The names of the VMs fleet.ts puts on `host`. */
export const guestsOf = (fleet: Fleet, host: string) =>
	fleet.machines.flatMap(({ name, vm }) =>
		Option.exists(vm, (settings) => settings.host === host) ? [name] : [],
	);
