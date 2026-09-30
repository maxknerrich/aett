import { Option, Predicate, Result, Schema, SchemaIssue } from "effect";

export const MachineName = Schema.String.check(
	Schema.isPattern(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, {
		expected: "a lowercase hostname label (a-z, 0-9 and inner hyphens, at most 63 characters)",
	}),
);

/** Every role gets the same base system; hypervisor and server ignore the laptop lid. */
export const Role = Schema.Literals(["hypervisor", "server", "computer"]);

export type Role = typeof Role.Type;

/** stable is the NixOS release aett pins; unstable opts a machine into nixos-unstable. */
export const Channel = Schema.Literals(["stable", "unstable"]);

export type Channel = typeof Channel.Type;

/** A nixpkgs attribute path such as "htop" or "python3Packages.rich". */
export const PackagePath = Schema.String.check(
	Schema.isPattern(/^[A-Za-z_][\w'-]*(\.[A-Za-z_][\w'-]*)*$/, {
		expected: 'a nixpkgs attribute path such as "htop" or "python3Packages.rich"',
	}),
);

/** How install lays out the disk: `encrypted` wraps the btrfs partition in LUKS. */
export const DiskOptions = Schema.Struct({
	encrypted: Schema.optionalKey(Schema.Boolean),
});

export const Machine = Schema.Struct({
	name: MachineName,
	role: Role,
	packages: Schema.optionalKey(Schema.Array(PackagePath)),
	channel: Schema.optionalKey(Channel),
	disk: Schema.optionalKey(DiskOptions),
});

export interface Machine extends Schema.Schema.Type<typeof Machine> {}

/** Whether the machine's btrfs partition sits inside LUKS. Disks are plain unless declared encrypted. */
export const isEncrypted = (machine: Machine) => machine.disk?.encrypted ?? false;

/** Reports every machine whose name an earlier machine already uses. */
const uniqueNames = Schema.makeFilter((machines: ReadonlyArray<Machine>) =>
	machines.flatMap((machine, index) =>
		machines.findIndex((other) => other.name === machine.name) < index
			? [{ path: [index, "name"], issue: `Expected a unique name, got "${machine.name}" again` }]
			: [],
	),
);

export const Fleet = Schema.Struct({
	machines: Schema.Array(Machine).check(uniqueNames),
});

export interface Fleet extends Schema.Schema.Type<typeof Fleet> {}

/** What fleet.ts must default-export before its machines are checked. */
export const Declaration = Schema.Struct({ machines: Schema.Array(Schema.Unknown) });

export interface Declaration extends Schema.Schema.Type<typeof Declaration> {}

const MachineLabel = Schema.Struct({ name: Schema.String });

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Decodes a declaration into a fleet. A failure holds one line per problem,
 * naming the machine as the operator wrote it, the field and what was wrong.
 * Unknown keys are problems too, so a misspelled option cannot pass unnoticed.
 */
export const decodeFleet = (declaration: Declaration): Result.Result<Fleet, string> =>
	Schema.decodeUnknownResult(Fleet)(declaration, {
		errors: "all",
		reportInput: true,
		onExcessProperty: "error",
	}).pipe(
		Result.mapError((error) =>
			formatIssue(error.issue)
				.issues.map(({ path = [], message }) => {
					const [, index, ...keys] = path;
					const inMachine = Predicate.isNumber(index);

					const where = inMachine
						? Schema.decodeUnknownOption(MachineLabel)(declaration.machines[index]).pipe(
								Option.match({
									onNone: () => `machines[${index}]`,
									onSome: ({ name }) => `machine("${name}")`,
								}),
							)
						: "fleet()";

					// Nested options such as disk.encrypted read as one field; array indexes are left out.
					const field = (inMachine ? keys : path).filter(Predicate.isString).join(".");

					return field === "" ? `${where}: ${message}` : `${where} ${field}: ${message}`;
				})
				.join("\n"),
		),
	);
