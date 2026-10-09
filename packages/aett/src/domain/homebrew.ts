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

/**
 * What Homebrew has that `declared` doesn't list, as "cask raycast",
 * "formula acsandmann/tap/rift" or "tap acsandmann/tap": what removing the
 * undeclared takes away. A formula from a tap counts by its full name, and a
 * tap one of the declared formulae comes from counts as declared.
 */
export const undeclaredHomebrew = (installed: Brewed, declared: Brewed) => {
	const brews = new Set(declared.brews.flatMap((name) => [name, name.split("/").at(-1) ?? name]));

	const taps = new Set([
		...declared.taps,
		...declared.brews.flatMap((name) => {
			const parts = name.split("/");

			return parts.length === 3 ? [parts.slice(0, 2).join("/")] : [];
		}),
	]);

	return [
		...installed.casks
			.filter((name) => !declared.casks.includes(name))
			.map((name) => `cask ${name}`),
		...installed.brews.filter((name) => !brews.has(name)).map((name) => `formula ${name}`),
		...installed.taps.filter((name) => !taps.has(name)).map((name) => `tap ${name}`),
	];
};
