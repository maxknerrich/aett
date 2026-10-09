/** What Homebrew has or a Brewfile lists: taps, formulae and casks. */
export interface Brewed {
	readonly taps: ReadonlyArray<string>;
	readonly brews: ReadonlyArray<string>;
	readonly casks: ReadonlyArray<string>;
}

// The names a Brewfile lists after `kind`, such as brew "mas".
const entries = (brewfile: string, kind: string) =>
	brewfile.split("\n").flatMap((line) => {
		const name = new RegExp(`^\\s*${kind}\\s+"([^"]+)"`).exec(line)?.[1];

		return name === undefined ? [] : [name];
	});

/** The taps, formulae and casks a Brewfile lists. */
export const brewfileEntries = (brewfile: string): Brewed => ({
	taps: entries(brewfile, "tap"),
	brews: entries(brewfile, "brew"),
	casks: entries(brewfile, "cask"),
});

// A name with the short name it also goes by: owner/tap/name is name too.
const withShort = (names: ReadonlyArray<string>) =>
	new Set(names.flatMap((name) => [name, name.split("/").at(-1) ?? name]));

// The tap of a name from one, such as owner/tap of owner/tap/name.
const tapOf = (name: string) => {
	const parts = name.split("/");

	return parts.length === 3 ? [parts.slice(0, 2).join("/")] : [];
};

/**
 * What Homebrew has that `declared` doesn't list, as "cask raycast",
 * "formula acsandmann/tap/rift" or "tap acsandmann/tap": what removing the
 * undeclared takes away. A formula or cask from a tap counts by its full name
 * or its own, and a tap a declared formula or cask comes from counts as
 * declared.
 */
export const undeclaredHomebrew = (installed: Brewed, declared: Brewed) => {
	const brews = withShort(declared.brews);
	const casks = withShort(declared.casks);

	const taps = new Set([
		...declared.taps,
		...declared.brews.flatMap(tapOf),
		...declared.casks.flatMap(tapOf),
	]);

	return [
		...installed.casks.filter((name) => !casks.has(name)).map((name) => `cask ${name}`),
		...installed.brews.filter((name) => !brews.has(name)).map((name) => `formula ${name}`),
		...installed.taps.filter((name) => !taps.has(name)).map((name) => `tap ${name}`),
	];
};
