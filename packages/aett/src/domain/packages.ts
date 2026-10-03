import { Predicate, Schema } from "effect";

/** A nixpkgs or llm-agents.nix attribute path such as "htop" or "python3Packages.rich". */
export const PackagePath = Schema.String.check(
	Schema.isPattern(/^[A-Za-z_][\w'-]*(\.[A-Za-z_][\w'-]*)*$/, {
		expected: 'a package name such as "htop" or "python3Packages.rich"',
	}),
);

/** A tool from a GitHub release: its repository, the asset with {version} and {target}, and the binary in it. */
export const Release = Schema.Struct({
	github: Schema.String.check(
		Schema.isPattern(/^[\w.-]+\/[\w.-]+$/, {
			expected: 'a GitHub repository such as "owner/name"',
		}),
	),
	asset: Schema.NonEmptyString,
	bin: Schema.String.check(
		Schema.isPattern(/^[\w.+-]+$/, { expected: "the name of a binary, without a path" }),
	),
});

export interface Release extends Schema.Schema.Type<typeof Release> {}

/** A package as an entry lists it: a name or a release(). */
export const Package = Schema.Union([PackagePath, Release]);

export type Package = typeof Package.Type;

/** The sources a package name can come from, in the order aett looks: the fastest first. */
export const Source = Schema.Literals(["llm-agents", "nixpkgs", "unstable"]);

export type Source = typeof Source.Type;

/** A list of packages split into names and releases, each sorted, releases one per repository. */
export const splitPackages = (packages: ReadonlyArray<Package>) => ({
	names: [...new Set(packages.filter(Predicate.isString))].toSorted(),
	releases: [
		...new Map(
			packages.flatMap((tool) => (Predicate.isString(tool) ? [] : [[tool.github, tool] as const])),
		).values(),
	].toSorted((a, b) => a.github.localeCompare(b.github)),
});
