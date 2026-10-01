import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	type PlatformError,
	Schema,
} from "effect";
import { Base64 } from "effect/encoding";
import { type Connection, shellQuote } from "../adapters/ssh.ts";
import { Entry, fillPlaceholders, type HomePlan, planSync } from "../domain/home.ts";

/** A problem syncing dotfile sets onto a machine. */
export class HomeError extends Schema.TaggedError<HomeError>()("HomeError", {
	message: Schema.String,
}) {}

/**
 * Reads every set under `<root>/home/` by name: regular files as text,
 * executable when any x bit is set, and symlinks as links with their targets
 * as written. .DS_Store files are left out; a fleet without home/ has no sets.
 */
export const readSets = Effect.fn("readSets")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = path.join(root, "home");

	// The entries under `tree`, their paths prefixed with `prefix`.
	const readTree = Effect.fnUntraced(function* (
		tree: string,
		prefix: string,
	): Effect.fn.Return<ReadonlyArray<Entry>, PlatformError.PlatformError> {
		const names = yield* fs.readDirectory(tree);

		const entries = yield* Effect.forEach(
			names.filter((name) => name !== ".DS_Store"),
			Effect.fnUntraced(function* (name: string) {
				const file = path.join(tree, name);
				const relative = `${prefix}${name}`;

				// readLink fails on anything but a link; stat then tells files from directories and reports real problems.
				const target = yield* Effect.option(fs.readLink(file));

				if (Option.isSome(target)) return [Entry.Link({ path: relative, target: target.value })];

				const info = yield* fs.stat(file);

				if (info.type === "Directory") return yield* readTree(file, `${relative}/`);

				if (info.type !== "File") return [];

				return [
					Entry.File({
						path: relative,
						content: yield* fs.readFileString(file),
						executable: (info.mode & 0o111) !== 0,
					}),
				];
			}),
		);

		return entries.flat();
	});

	if (!(yield* fs.exists(directory))) return new Map<string, ReadonlyArray<Entry>>();

	const sets = yield* fs
		.readDirectory(directory)
		.pipe(
			Effect.flatMap((names) =>
				Effect.filter(names, (name) =>
					fs.stat(path.join(directory, name)).pipe(Effect.map(({ type }) => type === "Directory")),
				),
			),
		);

	return new Map(
		yield* Effect.forEach(sets, (set) =>
			readTree(path.join(directory, set), "").pipe(
				Effect.map((entries) => [set, entries] as const),
			),
		),
	);
});

/** A planned sync of one user's home on one machine, which applyHome carries out. */
export interface HomeSync {
	readonly machine: string;
	readonly user: string;
	/** The user's home directory on the machine. */
	readonly home: string;
	readonly plan: HomePlan;
}

// Where the manifest lives in the home: each path the last sync placed, with its fingerprint.
const manifestPath = ".local/state/aett/home.json";

const Manifest = Schema.fromJsonString(
	Schema.Struct({ files: Schema.Record(Schema.String, Schema.String) }),
);

// Run as root: prints the user's home directory on the first line, then the manifest if there is one.
const locateScript = (user: string) => `home=$(getent passwd ${shellQuote(user)} | cut -d: -f6)
if [ -z "$home" ]; then echo ${shellQuote(`There is no user ${user}.`)} >&2; exit 1; fi
printf '%s\\n' "$home"
if [ -f "$home/${manifestPath}" ]; then cat -- "$home/${manifestPath}"; fi
`;

// Run as root: prints a line per path in the home, its fingerprint as domain/home.ts computes it,
// "other" for anything but a file or a link, or "missing". A path whose directory resolves outside
// the home, through a symlink on the machine, is "outside" and left unread.
const fingerprintScript = (home: string, paths: ReadonlyArray<string>) => `set -eu
cd -- ${shellQuote(home)}
root=$(pwd -P)
fingerprint() {
	case $(realpath -m -- "$(dirname -- "$1")") in
		"$root" | "$root"/*) ;;
		*) echo outside; return ;;
	esac
	if [ -L "$1" ]; then
		printf 'link:%s\\n' "$(readlink -- "$1")"
	elif [ -f "$1" ]; then
		hash=$(sha256sum < "$1")
		if [ -x "$1" ]; then printf 'x:%s\\n' "\${hash%% *}"; else printf '%s\\n' "\${hash%% *}"; fi
	elif [ -e "$1" ]; then
		echo other
	else
		echo missing
	fi
}
${paths.map((path) => `fingerprint ${shellQuote(path)}\n`).join("")}`;

// A line of the apply script that writes `content` to `path` with `mode`.
const putFile = (path: string, mode: string, content: string) =>
	`put_file ${shellQuote(path)} ${mode} ${shellQuote(Base64.encode(content))}\n`;

// Run as the user in their home: removes first, with the directories that leaves empty, so a file
// can give way to a directory and back. Then writes each file through a temporary one next to it and
// each link, and records the manifest last. A directory still standing where a file or link goes
// stops the sync, and -T keeps mv and ln from ever writing into one.
const applyScript = (home: string, plan: HomePlan) => {
	const steps = [
		...plan.remove.map((path) => `remove ${shellQuote(path)}\n`),
		...plan.write.map((entry) =>
			Entry.$match(entry, {
				File: ({ path, content, executable }) => putFile(path, executable ? "755" : "644", content),
				Link: ({ path, target }) => `put_link ${shellQuote(path)} ${shellQuote(target)}\n`,
			}),
		),
		...Option.toArray(
			Option.map(plan.manifest, (manifest) =>
				putFile(
					manifestPath,
					"644",
					`${JSON.stringify({ files: Object.fromEntries(manifest) }, null, "\t")}\n`,
				),
			),
		),
	];

	return `set -eu
umask 022
cd -- ${shellQuote(home)}
tmp=
trap 'if [ -n "$tmp" ]; then rm -f -- "$tmp"; fi' EXIT
remove() {
	rm -f -- "$1"
	dir=$(dirname -- "$1")
	while [ "$dir" != . ] && rmdir -- "$dir" 2>/dev/null; do dir=$(dirname -- "$dir"); done
}
make_room() {
	if [ -d "$1" ] && [ ! -L "$1" ]; then
		printf '%s is a directory, where aett puts a %s. Move it away and sync again.\\n' "$1" "$2" >&2
		exit 1
	fi
	mkdir -p -- "$(dirname -- "$1")"
}
put_file() {
	make_room "$1" file
	tmp=$(mktemp -- "$(dirname -- "$1")/.aett.XXXXXX")
	printf '%s' "$3" | base64 -d > "$tmp"
	chmod -- "$2" "$tmp"
	mv -fT -- "$tmp" "$1"
	tmp=
}
put_link() {
	make_room "$1" link
	ln -sfT -- "$2" "$1"
}
${steps.join("")}`;
};

// What a plan changes, for the operator, with the paths changed outside aett set apart.
const summary = ({ machine, user, plan }: HomeSync) => {
	if (!plan.changes) return `${user}'s home on ${machine} is up to date.`;

	const changes = [
		`Changes to ${user}'s home on ${machine}:`,
		...plan.write.map(({ path }) => `  write  ${path}`),
		...plan.remove.map((path) => `  remove ${path}`),
	];

	const local =
		plan.changedLocally.length === 0
			? []
			: [
					`Changed on ${machine} outside aett; syncing overwrites or removes them:`,
					...plan.changedLocally.map((path) => `  ${path}`),
				];

	return [...changes, ...local].join("\n");
};

/**
 * Compares `user`'s home on the machine with the entries it should hold,
 * their placeholders filled for `machine`, and prints what syncing changes.
 * Only reads the machine; applyHome carries the plan out once the operator
 * agrees.
 */
export const planHome = Effect.fn("planHome")(function* (
	connection: Connection,
	machine: string,
	user: string,
	entries: ReadonlyArray<Entry>,
) {
	const desired = fillPlaceholders(entries, machine);
	const [home = "", ...rest] = (yield* connection.run("sh -s", locateScript(user))).split("\n");
	const recorded = rest.join("\n");

	const manifest =
		recorded.trim() === ""
			? new Map<string, string>()
			: yield* Schema.decodeUnknownEffect(Manifest)(recorded).pipe(
					Effect.map(({ files }) => new Map(Object.entries(files))),
					Effect.catchTag("SchemaError", (error) =>
						Effect.fail(
							new HomeError({
								message: `${home}/${manifestPath} on ${machine} is invalid: ${error.message}`,
							}),
						),
					),
				);

	const paths = [...new Set([...desired.map(({ path }) => path), ...manifest.keys()])];
	const found = (yield* connection.run("sh -s", fingerprintScript(home, paths))).split("\n");

	// One line per path and the empty string after the last newline.
	if (found.length !== paths.length + 1) {
		return yield* new HomeError({
			message: `Could not tell what ${user}'s home on ${machine} holds: the machine printed unexpected fingerprints.`,
		});
	}

	const printed = Arr.zip(paths, found);
	const outside = printed.flatMap(([path, print]) => (print === "outside" ? [`  ${path}`] : []));

	if (outside.length > 0) {
		return yield* new HomeError({
			message: [
				`A symlink on ${machine} leads these paths out of ${home}, so aett won't touch them:`,
				...outside,
			].join("\n"),
		});
	}

	const current = new Map(printed.filter(([, print]) => print !== "missing"));

	const sync = {
		machine,
		user,
		home,
		plan: planSync(desired, manifest, current),
	} satisfies HomeSync;

	yield* Console.log(summary(sync));

	return sync;
});

/**
 * Carries out a plan from planHome as the user in one remote command: removes
 * and writes files, then records the manifest. Does nothing when there is
 * nothing to change or record.
 */
export const applyHome = Effect.fn("applyHome")(function* (connection: Connection, sync: HomeSync) {
	const { machine, user, home, plan } = sync;

	if (!plan.changes && Option.isNone(plan.manifest)) return;

	yield* connection.run(`runuser -u ${shellQuote(user)} -- sh -s`, applyScript(home, plan));

	if (plan.changes) yield* Console.log(`Synced ${user}'s home on ${machine}.`);
});
