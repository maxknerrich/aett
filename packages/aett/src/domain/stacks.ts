import { Schema, Struct } from "effect";

/** A nixpkgs attribute path such as "htop" or "python3Packages.rich". */
export const PackagePath = Schema.String.check(
	Schema.isPattern(/^[A-Za-z_][\w'-]*(\.[A-Za-z_][\w'-]*)*$/, {
		expected: 'a nixpkgs attribute path such as "htop" or "python3Packages.rich"',
	}),
);

/**
 * The service catalog: each service by name with its options, or false to keep
 * it off. Tailscale is a role default; a stack can turn it off on servers and
 * computers.
 */
export const Services = Schema.Struct({
	// No options yet; a record of nothing rejects every key, where an empty struct would not.
	tailscale: Schema.optionalKey(
		Schema.Union([Schema.Literal(false), Schema.Record(Schema.String, Schema.Never)]),
	),
});

export interface Services extends Schema.Schema.Type<typeof Services> {}

/** What a stack puts on a machine. */
export const StackContent = Schema.Struct({
	packages: Schema.optionalKey(Schema.Array(PackagePath)),
	fast: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
	apps: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
	services: Schema.optionalKey(Services),
	home: Schema.optionalKey(Schema.Literal(true)),
});

export interface StackContent extends Schema.Schema.Type<typeof StackContent> {}

/** A stack: content for every server and computer, and per machine under `machines`. */
export const Stack = Schema.Struct({
	...StackContent.fields,
	machines: Schema.optionalKey(Schema.Record(Schema.String, StackContent)),
});

export interface Stack extends Schema.Schema.Type<typeof Stack> {}

/** What the stacks put on one machine, all of them combined. */
export interface Resolved {
	readonly packages: ReadonlyArray<string>;
	readonly fast: ReadonlyArray<string>;
	readonly apps: ReadonlyArray<string>;
	/** The services some stack adds and none turns off. */
	readonly services: ReadonlyArray<keyof Services>;
	/** The services some stack turns off, which role defaults can't add either. */
	readonly off: ReadonlyArray<keyof Services>;
	readonly home: boolean;
}

/** The machine a stack is resolved for: its name and which of the stack's top-level keys reach it. */
export interface Target {
	readonly name: string;
	readonly computer: boolean;
}

const serviceNames = Struct.keys(Services.fields);

/**
 * Combines every stack for one machine. Within a stack, `machines.<name>`
 * extends the top level and wins for a service; top-level `apps` reach only
 * computers and top-level `home` only servers. Across stacks, lists add up and
 * a service any stack turns off stays off. The result doesn't depend on the
 * order of the stacks.
 */
export const resolveStacks = (stacks: ReadonlyArray<Stack>, target: Target): Resolved => {
	const contents = stacks.map((stack) => ({ top: stack, own: stack.machines?.[target.name] }));

	// Sorted, so the order stacks are written in can't change fleet.json or the build.
	const union = (pick: (content: StackContent) => ReadonlyArray<string> | undefined) =>
		[
			...new Set(
				contents.flatMap(({ top, own }) => [
					...(pick(top) ?? []),
					...(own === undefined ? [] : (pick(own) ?? [])),
				]),
			),
		].toSorted();

	// Each stack's say about a service: its machine entry wins over its top level. No catalog
	// service has options yet; merging options and replacing them on a role change, as
	// docs/declaration.md describes, arrive with the first service that has some.
	const settings = (service: keyof Services) =>
		contents.map(({ top, own }) => own?.services?.[service] ?? top.services?.[service]);

	return {
		packages: union((content) => content.packages),
		fast: union((content) => content.fast),
		apps: target.computer ? union((content) => content.apps) : [],
		services: serviceNames.filter((service) => {
			const said = settings(service);

			return !said.includes(false) && said.some((setting) => setting !== undefined);
		}),
		off: serviceNames.filter((service) => settings(service).includes(false)),
		home:
			!target.computer && contents.some(({ top, own }) => top.home === true || own?.home === true),
	};
};
