import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Data, Option, Result } from "effect";

/**
 * One path in a dotfile set, relative to the home directory: a text file, or
 * a symlink with its target as written.
 */
export type Entry = Data.TaggedEnum<{
	File: { readonly path: string; readonly content: string; readonly executable: boolean };
	Link: { readonly path: string; readonly target: string };
}>;

export const Entry = Data.taggedEnum<Entry>();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Lists set names as "a and b" or "a, b and c".
const listFormat = new Intl.ListFormat("en-GB");

// Why a set's link can't be kept, if it can't: it must be relative and lead to a path inside the home.
const linkProblems = (set: string, path: string, target: string) => {
	const file = `home/${set}/${path}`;

	if (posix.isAbsolute(target)) {
		return [`${file} links to the absolute path ${target}. Links in a set are relative.`];
	}

	const resolved = posix.join(posix.dirname(path), target);

	return resolved === ".." || resolved.startsWith("../")
		? [`${file} links to ${target}, which is outside the home.`]
		: [];
};

/**
 * Merges the dotfile sets a machine gets into its home, sorted by path so the
 * order of the sets can't change it. Links inside the home stay links, also
 * when they lead into another set. Fails with every problem, one per line: a
 * set missing from home/, a path in more than one set, and a link that is
 * absolute or leads out of the home.
 */
export const resolveHome = (
	sets: ReadonlyMap<string, ReadonlyArray<Entry>>,
	chosen: ReadonlyArray<string>,
): Result.Result<ReadonlyArray<Entry>, string> => {
	const names = [...new Set(chosen)].toSorted();

	const placed = names.flatMap((set) => (sets.get(set) ?? []).map((entry) => ({ set, entry })));

	const missing = names.flatMap((set) =>
		sets.has(set) ? [] : [`The dotfile set ${set} doesn't exist: there is no home/${set}/.`],
	);

	const conflicts = [...Map.groupBy(placed, ({ entry }) => entry.path)].flatMap(
		([path, owners]) => {
			const holders = listFormat.format(owners.map(({ set }) => set));

			return owners.length > 1
				? [`${path} is in ${owners.length === 2 ? "both " : ""}${holders}.`]
				: [];
		},
	);

	const links = placed.flatMap(({ set, entry }) =>
		Entry.$match(entry, {
			File: () => [],
			Link: ({ path, target }) => linkProblems(set, path, target),
		}),
	);

	const problems = [...missing, ...conflicts.toSorted(), ...links];

	return problems.length > 0
		? Result.fail(problems.join("\n"))
		: Result.succeed(
				placed.map(({ entry }) => entry).toSorted((a, b) => a.path.localeCompare(b.path)),
			);
};

// OKLCH lightness and chroma of every machine's color: mid lightness contrasts with dark and light backgrounds alike.
const lightness = 0.62;

const chroma = 0.12;

// A linear-light sRGB channel as a byte, clipped to the gamut.
const toByte = (linear: number) => {
	const clipped = Math.min(Math.max(linear, 0), 1);
	const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;

	return Math.round(encoded * 255);
};

/**
 * The machine's color as #rrggbb: a hue hashed from its name, at a fixed
 * OKLCH lightness and chroma so every machine's color reads equally well on
 * dark and light terminals.
 */
export const hostColor = (name: string) => {
	const hue = (Number.parseInt(sha256(name).slice(0, 4), 16) / 0x10000) * 2 * Math.PI;
	const a = chroma * Math.cos(hue);
	const b = chroma * Math.sin(hue);

	// OKLab to linear sRGB, by way of LMS.
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

	const channels = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];

	return `#${channels.map((channel) => toByte(channel).toString(16).padStart(2, "0")).join("")}`;
};

/**
 * Fills `{{host.name}}` and `{{host.color}}` in the files' contents with the
 * machine's name and color. Any other `{{…}}` stays as written.
 */
export const fillPlaceholders = (entries: ReadonlyArray<Entry>, name: string) => {
	const color = hostColor(name);

	return entries.map((entry) =>
		Entry.$match(entry, {
			File: ({ path, content, executable }) =>
				Entry.File({
					path,
					executable,
					content: content.replaceAll("{{host.name}}", name).replaceAll("{{host.color}}", color),
				}),
			Link: (link) => link,
		}),
	);
};

/**
 * What identifies an entry on a machine: a file's SHA-256 in hex, prefixed
 * with "x:" when it is executable, or "link:" and a link's target. The sync's
 * remote script prints the same for what it finds.
 */
export const fingerprint = (entry: Entry) =>
	Entry.$match(entry, {
		File: ({ content, executable }) => `${executable ? "x:" : ""}${sha256(content)}`,
		Link: ({ target }) => `link:${target}`,
	});

/** What syncing a machine's home does. */
export interface HomePlan {
	/** Entries to place: new, changed in their set, or changed on the machine. */
	readonly write: ReadonlyArray<Entry>;
	/** Paths aett placed that left their sets and are still on the machine. */
	readonly remove: ReadonlyArray<string>;
	/**
	 * Paths of `write` and `remove` that are not what aett left on the machine:
	 * edited there, or there before aett placed them. Syncing overwrites or
	 * removes them.
	 */
	readonly changedLocally: ReadonlyArray<string>;
	/** The manifest to record, each placed path's fingerprint, when it differs from the last one. */
	readonly manifest: Option.Option<ReadonlyMap<string, string>>;
	/** Whether syncing changes any file in the home. */
	readonly changes: boolean;
}

/**
 * Plans a sync from the entries the home should hold, the manifest of what
 * the last sync placed, and what the machine holds at each path of either,
 * all as fingerprints; a path missing on the machine is absent from `current`.
 */
export const planSync = (
	desired: ReadonlyArray<Entry>,
	manifest: ReadonlyMap<string, string>,
	current: ReadonlyMap<string, string>,
): HomePlan => {
	const next = new Map(desired.map((entry) => [entry.path, fingerprint(entry)]));

	const changedLocally = (path: string) => {
		const found = current.get(path);

		return found !== undefined && found !== manifest.get(path);
	};

	const write = desired.filter((entry) => current.get(entry.path) !== next.get(entry.path));

	const remove = [...manifest.keys()]
		.filter((path) => !next.has(path) && current.has(path))
		.toSorted();

	const alreadyRecorded =
		manifest.size === next.size &&
		[...next].every(([path, placed]) => manifest.get(path) === placed);

	return {
		write,
		remove,
		changedLocally: [...write.map(({ path }) => path), ...remove].filter(changedLocally).toSorted(),
		manifest: alreadyRecorded ? Option.none() : Option.some(next),
		changes: write.length > 0 || remove.length > 0,
	};
};
