import { Option, Predicate, Result, Schema, SchemaIssue } from "effect";
import { resolveStacks, Stack } from "./stacks.ts";

export const MachineName = Schema.String.check(
	Schema.isPattern(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, {
		expected: "a lowercase hostname label (a-z, 0-9 and inner hyphens, at most 63 characters)",
	}),
);

/** hypervisor: an appliance that only runs VMs; server: headless, reached over SSH; computer: graphical, used in person. */
export const Role = Schema.Literals(["hypervisor", "server", "computer"]);

export type Role = typeof Role.Type;

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
 * What fleet.ts must default-export before its machines and stacks are
 * checked. Other keys pass through so that decodeFleet can reject them.
 */
export const Declaration = Schema.StructWithRest(
	Schema.Struct({ machines: Schema.Record(Schema.String, Schema.Unknown) }),
	[Schema.Record(Schema.String, Schema.Unknown)],
);

export interface Declaration extends Schema.Schema.Type<typeof Declaration> {}

/** A user's login name, which NixOS takes: lowercase, shorter than 32 characters, and not root. */
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
	stacks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

export type Kind = "nixos" | "macos" | "vm";

/** Where a VM runs and its size, with the defaults filled in. Sizes are whole MiB. */
export interface VmSettings {
	/** The hypervisor or bare-metal server that builds and runs it. */
	readonly host: string;
	readonly cpu: number;
	readonly memory: number;
	/** Its state volume's size. */
	readonly disk: number;
}

/** A machine as aett works with it: what fleet.ts declares, with its stacks resolved. */
export interface Machine {
	readonly name: string;
	readonly role: Role;
	/** Bare-metal NixOS, a Mac, or a VM; only bare-metal NixOS comes from the installer. */
	readonly kind: Kind;
	readonly encrypted: boolean;
	readonly channel: Channel;
	/** Set exactly for a VM. */
	readonly vm: Option.Option<VmSettings>;
	/** On the tailnet: a role default that only a stack can turn off, and never on a hypervisor. */
	readonly tailscale: boolean;
	readonly packages: ReadonlyArray<string>;
	/** Its dotfile sets. Any set gives it a home: the fleet's user with a home directory that persists. */
	readonly home: ReadonlyArray<string>;
	/** What it declares that aett can't build yet; install and apply refuse it while there is any. */
	readonly unsupported: ReadonlyArray<string>;
}

export interface Fleet {
	/** The fleet's one user, whom every machine with a home has. */
	readonly user: Option.Option<string>;
	readonly machines: ReadonlyArray<Machine>;
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
		return Result.fail([`${at}: Expected hypervisor(…), server(…) or computer(…)`]);
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

/**
 * Decodes fleet.ts's default export into a fleet: every machine's shape, each
 * VM's host, the stacks and where they reach, then each machine with its
 * stacks resolved. A failure holds one line per problem, naming where it is.
 */
export const decodeFleet = (declaration: Declaration): Result.Result<Fleet, string> => {
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

	const stacks = Object.entries(top.success.stacks ?? {}).map(([name, stack]) =>
		decodeAt(Stack, stack, `stacks.${name}`).pipe(
			Result.map((decoded) => ({ name, stack: decoded })),
		),
	);

	const declarationProblems = [...failures(machines), ...failures(stacks)];

	if (declarationProblems.length > 0) return Result.fail(declarationProblems.join("\n"));

	const decoded = new Map(
		names.flatMap((name, index) => {
			const machine = machines[index];

			return machine !== undefined && Result.isSuccess(machine)
				? [[name, machine.success] as const]
				: [];
		}),
	);

	const declaredStacks = stacks.flatMap((result) =>
		Result.isSuccess(result) ? [result.success] : [],
	);

	const problems = [...hostProblems(decoded), ...reachProblems(decoded, declaredStacks)];

	if (problems.length > 0) return Result.fail(problems.join("\n"));

	const resolved = [...decoded].map(([name, machine]) => toMachine(name, machine, declaredStacks));
	const homed = resolved.find(({ home }) => home.length > 0);

	if (top.success.user === undefined && homed !== undefined) {
		return Result.fail(
			`fleet(): user is required, because a stack gives ${homed.name} a home. Name the fleet's user, such as user: "you".`,
		);
	}

	return Result.succeed({ user: Option.fromUndefinedOr(top.success.user), machines: resolved });
};

// Each VM's host must be a hypervisor or a bare-metal server.
const hostProblems = (machines: ReadonlyMap<string, Decoded>) =>
	[...machines].flatMap(([name, machine]) => {
		if (machine.host === undefined) return [];

		const host = machines.get(machine.host);

		if (host === undefined)
			return [`machines.${name}.host: There is no machine named "${machine.host}"`];

		return host.role === "hypervisor" || (host.role === "server" && host.kind === "nixos")
			? []
			: [
					`machines.${name}.host: ${machine.host} is a ${host.kind === "vm" ? "VM" : host.role}; a VM runs on a hypervisor or a bare-metal server`,
				];
	});

// Stacks reach declared servers and computers only, with what fits each.
const reachProblems = (
	machines: ReadonlyMap<string, Decoded>,
	stacks: ReadonlyArray<{ readonly name: string; readonly stack: Stack }>,
) =>
	stacks.flatMap(({ name, stack }) =>
		Object.entries(stack.machines ?? {}).flatMap(([machineName, content]) => {
			const at = `stacks.${name}.machines.${machineName}`;
			const machine = machines.get(machineName);

			if (machine === undefined) return [`${at}: There is no machine named "${machineName}"`];

			if (machine.role === "hypervisor") {
				return [`${at}: ${machineName} is a hypervisor; stacks never reach hypervisors`];
			}

			if (machine.role === "server" && content.apps !== undefined) {
				return [`${at}.apps: ${machineName} is a server; apps need a computer`];
			}

			return [];
		}),
	);

// The machine aett works with: its settings, the packages its stacks bring and what it declares that aett can't build yet.
const toMachine = (
	name: string,
	machine: Decoded,
	stacks: ReadonlyArray<{ readonly stack: Stack }>,
): Machine => {
	const resolved =
		machine.role === "hypervisor"
			? { packages: [], fast: [], apps: [], services: [], off: [], home: [] }
			: resolveStacks(
					stacks.map(({ stack }) => stack),
					{ name, computer: machine.role === "computer" },
				);

	const { system } = machine;

	const unsupported = [
		machine.kind === "macos" ? ["Macs"] : [],
		system.desktop === undefined ? [] : ["desktops"],
		resolved.fast.length > 0 ? ["fast packages"] : [],
		resolved.apps.length > 0 ? ["apps"] : [],
	].flat();

	return {
		name,
		role: machine.role,
		kind: machine.kind,
		encrypted: system.encrypted === true,
		channel: system.channel ?? "stable",
		vm: Option.map(Option.fromUndefinedOr(machine.host), (host) => ({
			host,
			cpu: system.cpu ?? 2,
			memory: mebibytes(system.memory ?? "2 GiB"),
			disk: mebibytes(system.disk ?? "20 GiB"),
		})),
		tailscale: !resolved.off.includes("tailscale"),
		home: resolved.home,
		packages: resolved.packages,
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
