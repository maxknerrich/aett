import { Option, Predicate, Schema } from "effect";

/**
 * A package name: an attribute path such as "htop" or
 * "python3Packages.rich", or a Homebrew name such as "1password" or
 * "firefox@developer-edition", whose source aett picks; or one led by the
 * source it comes from, such as "nixpkgs.htop", "unstable.zed-editor",
 * "llm-agents.claude-code", "cask.raycast" or "brew.acsandmann/tap/rift".
 */
export const PackagePath = Schema.String.check(
	Schema.isPattern(/^(?:(?:cask|brew)\.[\w.+@/-]+|\w[\w'@+-]*(\.\w[\w'@+-]*)*)$/, {
		expected:
			'a package name such as "htop", "python3Packages.rich" or one led by its source, such as "cask.raycast"',
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

/**
 * Tools aett knows by name that no Nix source has, from their GitHub
 * releases. On a Mac the name goes to Homebrew like any other.
 */
export const knownReleases: ReadonlyMap<string, Release> = new Map([
	["vite-plus", { github: "voidzero-dev/vite-plus", asset: "vp-{target}.tar.gz", bin: "vp" }],
]);

/** A package as an entry lists it: a name or a release(). */
export const Package = Schema.Union([PackagePath, Release]);

export type Package = typeof Package.Type;

/** The Nix sources of packages, in the order aett looks: the fastest first. */
export const nixSources = ["llm-agents", "nixpkgs", "unstable"] as const;

export type NixSource = (typeof nixSources)[number];

/** Where a package comes from: a Nix source, or on a Mac a Homebrew cask or formula. */
export const Source = Schema.Literals([...nixSources, "cask", "brew"]);

export type Source = typeof Source.Type;

/** The systems a package's source is picked for: the same name can come from nixpkgs on Linux and as a cask on a Mac. */
export type Family = "linux" | "darwin";

/** A package as a source names it: its source and its name there. */
export interface Sourced {
	readonly source: Source;
	readonly name: string;
}

/** The source a package name is led by, if it is, with its name there. */
export const explicitSource = (name: string): Option.Option<Sourced> => {
	const dot = name.indexOf(".");
	const lead = name.slice(0, dot);

	return dot > 0 && Schema.is(Source)(lead)
		? Option.some({ source: lead, name: name.slice(dot + 1) })
		: Option.none();
};

/** A list of packages split into names and releases, each sorted, releases one per repository. */
export const splitPackages = (packages: ReadonlyArray<Package>) => ({
	names: [...new Set(packages.filter(Predicate.isString))].toSorted(),
	releases: [
		...new Map(
			packages.flatMap((tool) => (Predicate.isString(tool) ? [] : [[tool.github, tool] as const])),
		).values(),
	].toSorted((a, b) => a.github.localeCompare(b.github)),
});
