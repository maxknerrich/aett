import { Match, Option, Predicate, Result, Schema, SchemaIssue } from "effect";
import { explicitSource, knownReleases, Package, type Release, splitPackages } from "./packages.ts";
import type { Plugin, Role as PluginRole } from "./plugin.ts";
import { machineSecrets } from "./secrets.ts";
import { shippedPlugins as shipped } from "./shipped.ts";

export const MachineName = Schema.String.check(
	Schema.isPattern(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, {
		expected: "a lowercase hostname label (a-z, 0-9 and inner hyphens, at most 63 characters)",
	}),
	// A machine keeps its secrets in secrets/<name>/, next to the user's and the services'.
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

/** A tag, a group's name or a service's: a lowercase word. dotfiles/<word>/ follows it. */
export const Word = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/, {
		expected: "a lowercase word: a-z, 0-9, dots, dashes and underscores",
	}),
	Schema.makeFilter(
		(name: string) => name !== "default" || "Expected another word: default means every machine",
	),
);

const Tags = Schema.Array(Word);

const Nixos = {
	tags: Schema.optionalKey(Tags),
	encrypted: Schema.optionalKey(Schema.Boolean),
	channel: Schema.optionalKey(Channel),
};

// One shape per kind of machine; which applies follows from its role, host and os.
const Hypervisor = Schema.Struct({ role: Schema.Literal("hypervisor"), ...Nixos });

const Nas = Schema.Struct({
	role: Schema.Literal("nas"),
	tags: Schema.optionalKey(Tags),
	channel: Schema.optionalKey(Channel),
});

const Server = Schema.Struct({ role: Schema.Literal("server"), ...Nixos });

const Vm = Schema.Struct({
	role: Schema.Literal("server"),
	host: MachineName,
	tags: Schema.optionalKey(Tags),
	cpu: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	memory: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.5))),
	disk: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
	channel: Schema.optionalKey(Channel),
});

const Computer = Schema.Struct({
	role: Schema.Literal("computer"),
	...Nixos,
	desktop: Schema.optionalKey(Schema.NonEmptyString),
});

const Mac = Schema.Struct({
	role: Schema.Literal("computer"),
	os: Schema.Literal("macos"),
	tags: Schema.optionalKey(Tags),
	channel: Schema.optionalKey(Channel),
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
 * What fleet.ts must default-export before its machines, services and
 * packages are checked. Other keys pass through so that decodeFleet can
 * reject them.
 */
export const Declaration = Schema.StructWithRest(
	Schema.Struct({ machines: Schema.Record(Schema.String, Schema.Unknown) }),
	[Schema.Record(Schema.String, Schema.Unknown)],
);

export interface Declaration extends Schema.Schema.Type<typeof Declaration> {}

// A value as fleet.ts declares it, before it is decoded.
type Raw = Declaration["machines"][string];

/** A user's login name, which NixOS and macOS take: lowercase, shorter than 32 characters, and not root. */
export const UserName = Schema.String.check(
	Schema.isPattern(/^[a-z_][a-z0-9_-]{0,30}$/, {
		expected: "a lowercase login name of at most 31 characters",
	}),
	Schema.makeFilter(
		(name: string) => name !== "root" || "Expected a user other than root, which aett keeps locked",
	),
);

const Top = Schema.Struct({
	user: Schema.optionalKey(UserName),
	machines: Schema.Record(Schema.String, Schema.Unknown),
	services: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	packages: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

/** What aett checks of a service's definition: the rest is read where it is used. */
export const PluginMetadata = Schema.Struct({
	name: Word,
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

/** A service on one machine: as an instance with its settings there, or as a client of the instances. */
export interface Placement {
	readonly name: string;
	readonly instance: boolean;
	/** The settings for this machine, as the service's schema decoded them: default, then tags, then the machine. */
	readonly options: unknown;
}

/** A service as the fleet places it: the machines it configures. */
export interface Service {
	readonly plugin: Plugin;
	readonly instances: ReadonlyArray<string>;
	/** Machines it configures as clients of the instances. */
	readonly clients: ReadonlyArray<string>;
}

/** A machine as aett works with it: what fleet.ts declares, with its services and packages resolved. */
export interface Machine {
	readonly name: string;
	readonly role: Role;
	/** Bare-metal NixOS, a Mac, or a VM; only bare-metal NixOS comes from the installer. */
	readonly kind: Kind;
	readonly tags: ReadonlyArray<string>;
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
	/** The services on it. */
	readonly services: ReadonlyArray<Placement>;
	/** The trees under dotfiles/ that land in its home: default, its tags, its services and its own. */
	readonly home: ReadonlyArray<string>;
	/** What it declares that aett can't build yet; install and apply refuse it while there is any. */
	readonly unsupported: ReadonlyArray<string>;
}

export interface Fleet {
	/** The fleet's one user, whom every machine but a hypervisor has. */
	readonly user: Option.Option<string>;
	readonly machines: ReadonlyArray<Machine>;
	/** Every service some machine has, by name. */
	readonly services: ReadonlyMap<string, Service>;
	/** The fleet's own services, from services/<name>/, which aett copies into the build. */
	readonly plugins: ReadonlyArray<Plugin>;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

// Decodes `input` with `schema`, rejecting unknown keys. A failure holds one line per problem, prefixed with where it is.
const decodeAt = <S extends Schema.Decoder<unknown>>(schema: S, input: Raw, at: string) =>
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
	readonly tags: ReadonlyArray<string>;
	readonly settings: {
		readonly encrypted?: boolean;
		readonly channel?: Channel;
		readonly desktop?: string;
		readonly cpu?: number;
		readonly memory?: number;
		readonly disk?: number;
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
const decodeMachine = (name: string, input: Raw): Result.Result<Decoded, ReadonlyArray<string>> => {
	const at = `machines.${name}`;
	const declared = decodeAt(Declared, input, at);

	if (Result.isFailure(declared)) {
		return Result.fail([
			`${at}: Expected mac(…), vm(…), server(…), computer(…), nas(…) or hypervisor(…)`,
		]);
	}

	const { role, host, os } = declared.success;

	if (role !== "server" && host !== undefined) {
		return Result.fail([`${at}.host: Only a server can be a VM; a ${role} runs on bare metal`]);
	}

	const vm = host !== undefined;
	const macos = os === "macos";

	return decodeAt(declarationFor(role, vm, macos), input, at).pipe(
		Result.map(({ tags, ...settings }) => ({
			name,
			role,
			kind: vm ? "vm" : macos ? "macos" : "nixos",
			host: "host" in settings ? settings.host : undefined,
			tags: tags ?? [],
			settings,
		})),
	);
};

// Every problem a list of decode results holds.
const failures = <A>(results: ReadonlyArray<Result.Result<A, ReadonlyArray<string>>>) =>
	results.flatMap((result) => (Result.isFailure(result) ? result.failure : []));

// The successes of a list of decode results.
const successes = <A>(results: ReadonlyArray<Result.Result<A, ReadonlyArray<string>>>) =>
	results.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []));

// The system a machine's modules are for.
const systemOf = (machine: Decoded) => (machine.kind === "macos" ? "darwin" : "nixos");

// What a machine is, as an error names it: a Mac, a VM or its role.
const describeKind = (machine: Decoded) =>
	Match.value(machine.kind).pipe(
		Match.when("macos", () => "a Mac"),
		Match.when("vm", () => "a VM"),
		Match.orElse(() => `a ${machine.role}`),
	);

// Whether a service can run on a machine. Caddy serves web endpoints on NixOS only.
const fits = (plugin: Plugin, machine: Decoded) =>
	(plugin.roles ?? Role.literals).includes(machine.role) &&
	(plugin.systems ?? ["nixos", "darwin"]).includes(systemOf(machine)) &&
	!(
		systemOf(machine) === "darwin" &&
		Object.values(plugin.endpoints ?? {}).some(({ web }) => web === true)
	);

// The keys a target can be: "default", a machine or a tag, which resolves to its machines.
const resolverFor = (machines: ReadonlyArray<Decoded>) => {
	const known = new Set(machines.flatMap(({ tags }) => tags));

	return {
		isTarget: (key: string) =>
			key === "default" || known.has(key) || machines.some(({ name }) => name === key),
		/** The machines `target` names, or why it names none. Named alone, a machine is explicit. */
		resolve: (
			target: Raw,
			at: string,
		): Result.Result<
			{ machines: ReadonlyArray<Decoded>; explicit: boolean },
			ReadonlyArray<string>
		> => {
			if (!Predicate.isString(target))
				return Result.fail([`${at}: Expected a machine, a tag or default`]);

			if (target === "default") return Result.succeed({ machines, explicit: false });

			const machine = machines.find(({ name }) => name === target);

			if (machine !== undefined) return Result.succeed({ machines: [machine], explicit: true });

			return known.has(target)
				? Result.succeed({
						machines: machines.filter(({ tags }) => tags.includes(target)),
						explicit: false,
					})
				: Result.fail([`${at}: There is no machine or tag named "${target}"`]);
		},
	};
};

type Resolver = ReturnType<typeof resolverFor>;

/** A service and the machines it is on, with each instance's settings. */
interface Placed {
	readonly plugin: Plugin;
	readonly instances: ReadonlyMap<string, unknown>;
	readonly clients: ReadonlyArray<string>;
}

// The settings a service takes, decoded: its options, or nothing at all for a service without.
const decodeSettings = (plugin: Plugin, input: Raw, at: string) =>
	plugin.options === undefined
		? Predicate.isObject(input) && Object.keys(input).length > 0
			? Result.fail(
					Object.keys(input).map(
						(key) => `${at}.${key}: Unexpected key; ${plugin.name} takes no settings`,
					),
				)
			: Result.succeed({})
		: decodeAt(plugin.options, input, at);

// The keys of a service with clients: its server and the machines it leaves out.
const ClientsEntry = Schema.Struct({
	server: MachineName,
	exclude: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});

// A service with clients, such as backup: its server, and as clients every other machine with the
// user or a service's state that it has modules for, but those `exclude` names.
const placeWithClients = (
	plugin: Plugin,
	value: Raw,
	machines: ReadonlyArray<Decoded>,
	resolver: Resolver,
): Result.Result<Placed, ReadonlyArray<string>> => {
	const at = `services.${plugin.name}`;

	if (!Predicate.isObject(value) || Array.isArray(value)) {
		return Result.fail([`${at}: Expected { server: "<machine>" }, the machine it runs on`]);
	}

	const keys = Object.entries(value);
	const own = (key: string) => key in ClientsEntry.fields;
	const entry = decodeAt(ClientsEntry, Object.fromEntries(keys.filter(([key]) => own(key))), at);

	const settings = decodeSettings(
		plugin,
		Object.fromEntries(keys.filter(([key]) => !own(key))),
		at,
	);

	if (Result.isFailure(entry) || Result.isFailure(settings)) {
		return Result.fail([...failures([entry]), ...failures([settings])]);
	}

	const server = machines.find(({ name }) => name === entry.success.server);

	if (server === undefined) {
		return Result.fail([`${at}.server: There is no machine named "${entry.success.server}"`]);
	}

	if (!fits(plugin, server)) {
		return Result.fail([
			`${at}.server: ${plugin.name} can't run on ${server.name}, which is ${describeKind(server)}`,
		]);
	}

	const given = entry.success.exclude;

	const excluded = (Predicate.isString(given) ? [given] : (given ?? [])).map((target) =>
		resolver.resolve(target, `${at}.exclude`),
	);

	if (failures(excluded).length > 0) return Result.fail(failures(excluded));

	const left = new Set(
		successes(excluded).flatMap(({ machines: named }) => named.map(({ name }) => name)),
	);

	return Result.succeed({
		plugin,
		instances: new Map([[server.name, settings.success]]),
		clients: machines.flatMap((machine) =>
			machine.name !== server.name &&
			!left.has(machine.name) &&
			machine.role !== "hypervisor" &&
			(plugin.systems ?? ["nixos", "darwin"]).includes(systemOf(machine))
				? [machine.name]
				: [],
		),
	});
};

// A service placed by targets: a target or a list of them with no settings, or settings by target,
// which apply on each machine in order: default, then its tags, then the machine itself.
const placeByTargets = (
	plugin: Plugin,
	value: Raw,
	machines: ReadonlyArray<Decoded>,
	resolver: Resolver,
): Result.Result<Placed, ReadonlyArray<string>> => {
	const at = `services.${plugin.name}`;

	const byTarget: ReadonlyArray<readonly [string, unknown]> =
		Predicate.isString(value) || Array.isArray(value)
			? (Predicate.isString(value) ? [value] : value).map((target) => [String(target), {}] as const)
			: Predicate.isObject(value)
				? Object.entries(value)
				: [];

	if (byTarget.length === 0) {
		return Result.fail([
			`${at}: Expected a machine, a tag, default, a list of them, or settings by target`,
		]);
	}

	const resolved = byTarget.map(([target, settings]) =>
		resolver
			.resolve(target, Array.isArray(value) || Predicate.isString(value) ? at : `${at}.${target}`)
			.pipe(
				Result.flatMap(({ machines: named, explicit }) => {
					const misplaced = explicit ? named.filter((machine) => !fits(plugin, machine)) : [];

					return misplaced.length > 0
						? Result.fail(
								misplaced.map(
									(machine) =>
										`${at}: ${plugin.name} can't run on ${machine.name}, which is ${describeKind(machine)}`,
								),
							)
						: Result.succeed({
								target,
								settings: Predicate.isObject(settings) ? settings : {},
								machines: named.filter((machine) => fits(plugin, machine)),
							});
				}),
			),
	);

	if (failures(resolved).length > 0) return Result.fail(failures(resolved));

	const targets = successes(resolved);

	const on = machines.filter((machine) =>
		targets.some(({ machines: named }) => named.includes(machine)),
	);

	// default first, then the tags in the machine's order, then the machine.
	const rank = (machine: Decoded, target: string) =>
		target === "default"
			? -1
			: target === machine.name
				? machine.tags.length
				: machine.tags.indexOf(target);

	const instances = on.map((machine) => {
		const merged = Object.assign(
			{},
			...targets
				.filter(({ machines: named }) => named.includes(machine))
				.toSorted((a, b) => rank(machine, a.target) - rank(machine, b.target))
				.map(({ settings }) => settings),
		);

		return decodeSettings(plugin, merged, at).pipe(
			Result.map((options) => [machine.name, options] as const),
		);
	});

	if (failures(instances).length > 0) return Result.fail([...new Set(failures(instances))]);

	if (plugin.single === true && on.length !== 1) {
		return Result.fail([`${at}: ${plugin.name} runs on exactly one machine`]);
	}

	return Result.succeed({ plugin, instances: new Map(successes(instances)), clients: [] });
};

// Decodes one entry of `services`: the service it names, placed by its shape.
const placeService = (
	name: string,
	value: Raw,
	plugins: ReadonlyMap<string, Plugin>,
	machines: ReadonlyArray<Decoded>,
	resolver: Resolver,
): Result.Result<Placed, ReadonlyArray<string>> => {
	const plugin = plugins.get(name);

	if (plugin === undefined) {
		return Result.fail([
			`services.${name}: aett ships no service named ${name}, and the fleet has no services/${name}/`,
		]);
	}

	if (plugin.always === true) {
		return Result.fail([
			`services.${name}: ${name} is on every machine already and takes no entry`,
		]);
	}

	return plugin.clients === true
		? placeWithClients(plugin, value, machines, resolver)
		: placeByTargets(plugin, value, machines, resolver);
};

/** The packages one target or group gives the machines it names. */
interface Given {
	readonly machines: ReadonlyArray<string>;
	readonly packages: ReadonlyArray<Package>;
}

// One entry of `packages`: a target and its packages, or a group of its own name with targets and theirs.
// A hypervisor gets none; named alone, it is an error.
const givePackages = (
	key: string,
	value: Raw,
	resolver: Resolver,
): Result.Result<ReadonlyArray<Given>, ReadonlyArray<string>> => {
	const listed = (target: string, packages: Raw, at: string) =>
		resolver.resolve(target, at).pipe(
			Result.flatMap(({ machines: named, explicit }) => {
				const list = decodeAt(Schema.Array(Package), packages, at);

				if (Result.isFailure(list)) return Result.fail(list.failure);

				if (explicit && named.every(({ role }) => role === "hypervisor")) {
					return Result.fail([
						`${at}: ${target} is a hypervisor, which runs only VMs and services`,
					]);
				}

				return Result.succeed({
					machines: named.flatMap(({ name, role }) => (role === "hypervisor" ? [] : [name])),
					packages: list.success,
				});
			}),
		);

	if (resolver.isTarget(key))
		return listed(key, value, `packages.${key}`).pipe(Result.map((given) => [given]));

	const named = decodeAt(Word, key, "packages");

	if (Result.isFailure(named)) return Result.fail(named.failure);

	if (!Predicate.isObject(value) || Array.isArray(value)) {
		return Result.fail([
			`packages.${key}: There is no machine or tag named "${key}". A group of that name takes targets and their packages, such as ${key}: { zeus: ["git"] }`,
		]);
	}

	const groups = Object.entries(value).map(([target, packages]) =>
		listed(target, packages, `packages.${key}.${target}`),
	);

	return failures(groups).length > 0
		? Result.fail(failures(groups))
		: Result.succeed(successes(groups));
};

/**
 * Decodes fleet.ts's default export into a fleet: every machine's shape and
 * tags, each VM's host, each service and where it is with its settings there,
 * and each machine's packages. `own` are the fleet's own services from
 * services/<name>/. A failure holds one line per problem, naming where it is.
 */
export const decodeFleet = (
	declaration: Declaration,
	own: ReadonlyArray<Plugin> = [],
): Result.Result<Fleet, string> => {
	if ("stacks" in declaration || "plugins" in declaration) {
		return Result.fail(
			'fleet(): stacks and plugins are gone. Machines carry tags, services: { t3code: "zeus" } places services, packages: { dev: ["git"] } lists packages, and a service of your own lives in services/<name>/.',
		);
	}

	const top = decodeAt(Top, declaration, "fleet()");

	if (Result.isFailure(top)) return Result.fail(top.failure.join("\n"));

	const machineResults = Object.entries(top.success.machines).map(
		([name, input]): Result.Result<Decoded, ReadonlyArray<string>> =>
			Option.isSome(Schema.decodeUnknownOption(MachineName)(name))
				? decodeMachine(name, input)
				: Result.fail([
						`machines.${name}: Expected a lowercase hostname label: a-z, 0-9 and inner hyphens`,
					]),
	);

	const clashes = own.flatMap(({ name }) =>
		shipped.some((plugin) => plugin.name === name)
			? [`services/${name}/: aett already ships a service named ${name}`]
			: [],
	);

	const machineProblems = [...failures(machineResults), ...clashes];

	if (machineProblems.length > 0) return Result.fail(machineProblems.join("\n"));

	const machines = successes(machineResults);
	const names = new Set(machines.map(({ name }) => name));

	const tagProblems = machines.flatMap(({ name, tags }) =>
		tags.flatMap((tag) =>
			names.has(tag) ? [`machines.${name}.tags: ${tag} is a machine's name`] : [],
		),
	);

	const problemsSoFar = [...tagProblems, ...hostProblems(machines)];

	if (problemsSoFar.length > 0) return Result.fail(problemsSoFar.join("\n"));

	const resolver = resolverFor(machines);

	const plugins = new Map<string, Plugin>(
		[...shipped, ...own].map((plugin) => [plugin.name, plugin]),
	);

	const declared = Object.entries(top.success.services ?? {}).map(([name, value]) =>
		placeService(name, value, plugins, machines, resolver),
	);

	// Services that are on every machine without an entry, such as tailscale.
	const always = [...plugins.values()].flatMap((plugin): ReadonlyArray<Placed> =>
		plugin.always === true
			? [
					{
						plugin,
						instances: new Map(
							machines.flatMap((machine) => (fits(plugin, machine) ? [[machine.name, {}]] : [])),
						),
						clients: [],
					},
				]
			: [],
	);

	const given = Object.entries(top.success.packages ?? {}).map(([key, value]) =>
		givePackages(key, value, resolver),
	);

	const problems = [...failures(declared), ...failures(given)];

	if (problems.length > 0) return Result.fail(problems.join("\n"));

	const lists = successes(given).flat();
	const releases = releaseProblems(lists);

	if (releases.length > 0) return Result.fail(releases.join("\n"));

	const hasUser = machines.some(({ role }) => role !== "hypervisor");

	if (top.success.user === undefined && hasUser) {
		return Result.fail(
			`fleet(): user is required, because every machine but a hypervisor has the fleet's user. Name it, such as user: "you".`,
		);
	}

	const placed = [...always, ...successes(declared)];

	const services = new Map(
		placed.map(({ plugin, instances, clients }) => [
			plugin.name,
			{ plugin, instances: [...instances.keys()], clients } satisfies Service,
		]),
	);

	const fleet: Fleet = {
		user: Option.fromUndefinedOr(top.success.user),
		machines: machines.map((machine) => toMachine(machine, placed, lists)),
		services,
		plugins: own,
	};

	// A service's secret named like aett's own, such as a service users with a secret named after the
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
							`services: ${name} is the name of two secrets; rename the service or its secret`,
					)
					.join("\n"),
			)
		: Result.succeed(fleet);
};

// A repository's release is declared the same way wherever it appears, since aett pins one per repository.
const releaseProblems = (lists: ReadonlyArray<Given>) => {
	const declared = lists.flatMap(({ packages }) =>
		packages.flatMap((tool) => (Predicate.isString(tool) ? [] : [tool])),
	);

	return [...Map.groupBy(declared, ({ github }) => github)].flatMap(([github, uses]) =>
		new Set(uses.map(({ asset, bin }) => `${asset}\0${bin}`)).size > 1
			? [
					`packages: ${github} is released with different asset or bin; declare it once and share it.`,
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

// The machine aett works with: its settings, its services and packages, and what aett can't build yet.
const toMachine = (
	machine: Decoded,
	placed: ReadonlyArray<Placed>,
	lists: ReadonlyArray<Given>,
): Machine => {
	const user = machine.role !== "hypervisor";
	const { settings } = machine;
	const macos = machine.kind === "macos";

	const placements = placed.flatMap(({ plugin, instances, clients }): ReadonlyArray<Placement> => {
		if (instances.has(machine.name)) {
			return [{ name: plugin.name, instance: true, options: instances.get(machine.name) }];
		}

		return clients.includes(machine.name)
			? [{ name: plugin.name, instance: false, options: {} }]
			: [];
	});

	// Each service on it brings its package, which its modules run and the operator can use there.
	const servicePackages = placed.flatMap(({ plugin }) =>
		placements.some(({ name }) => name === plugin.name) && plugin.package !== undefined
			? [plugin.package]
			: [],
	);

	const listed = lists.flatMap(({ machines: named, packages }) =>
		named.includes(machine.name) ? packages : [],
	);

	const { names, releases } = splitPackages(listed);

	// Off a Mac, a tool aett knows by name comes from its release.
	const known = macos
		? []
		: names.flatMap((name) => Option.toArray(Option.fromUndefinedOr(knownReleases.get(name))));

	return {
		name: machine.name,
		role: machine.role,
		kind: machine.kind,
		tags: machine.tags,
		encrypted: machine.role === "nas" || settings.encrypted === true,
		// Computers follow nixpkgs unstable, the rest stable, unless fleet.ts says otherwise.
		channel: settings.channel ?? (machine.role === "computer" ? "unstable" : "stable"),
		vm: Option.map(Option.fromUndefinedOr(machine.host), (host) => ({
			host,
			cpu: settings.cpu ?? 2,
			memory: Math.floor((settings.memory ?? 2) * 1024),
			disk: Math.floor((settings.disk ?? 20) * 1024),
		})),
		user,
		// Homebrew's reach only Macs; a known release replaces its name off one.
		packages: [...new Set([...names, ...servicePackages])]
			.filter(
				(name) =>
					(macos ||
						!Option.exists(
							explicitSource(name),
							({ source }) => source === "cask" || source === "brew",
						)) &&
					(macos || !knownReleases.has(name)),
			)
			.toSorted(),
		releases: [
			...new Map([...releases, ...known].map((release) => [release.github, release])).values(),
		],
		services: placements,
		// Services on every machine bring no dotfiles of their own.
		home: user
			? [
					"default",
					...machine.tags,
					...placements.flatMap(({ name, instance }) =>
						instance && placed.some(({ plugin }) => plugin.name === name && plugin.always !== true)
							? [name]
							: [],
					),
					machine.name,
				]
			: [],
		unsupported: settings.desktop === undefined ? [] : ["desktops"],
	};
};

/** The names of the VMs fleet.ts puts on `host`. */
export const guestsOf = (fleet: Fleet, host: string) =>
	fleet.machines.flatMap(({ name, vm }) =>
		Option.exists(vm, (settings) => settings.host === host) ? [name] : [],
	);
