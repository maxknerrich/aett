import { DateTime, Option, Predicate, Schema } from "effect";
import type { Release } from "./stacks.ts";

// A value in a lock node's `locked` or `original`.
const LockValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

const LockNode = Schema.Struct({
	// An input's node, or a path of input names it follows from the root.
	inputs: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
	),
	locked: Schema.optionalKey(Schema.Record(Schema.String, LockValue)),
	original: Schema.optionalKey(Schema.Record(Schema.String, LockValue)),
	flake: Schema.optionalKey(Schema.Boolean),
});

interface LockNode extends Schema.Schema.Type<typeof LockNode> {}

/** The revisions of the engine's inputs, as a flake.lock holds them. */
export const InputsLock = Schema.Struct({
	nodes: Schema.Record(Schema.String, LockNode),
	root: Schema.String,
	version: Schema.Number,
});

export interface InputsLock extends Schema.Schema.Type<typeof InputsLock> {}

/** A release source's pin: what it was resolved from, its version, and an asset per platform. */
export const ReleasePin = Schema.Struct({
	asset: Schema.String,
	bin: Schema.String,
	version: Schema.String,
	assets: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String, hash: Schema.String })),
});

export interface ReleasePin extends Schema.Schema.Type<typeof ReleasePin> {}

/**
 * state/pins.json: the fleet's own pins. `inputs` locks the engine's inputs;
 * `releases` pins each release source by its repository.
 */
export const Pins = Schema.Struct({
	inputs: InputsLock,
	releases: Schema.Record(Schema.String, ReleasePin),
});

export interface Pins extends Schema.Schema.Type<typeof Pins> {}

/** The platforms aett resolves release assets for. */
export const platforms = ["x86_64-linux", "aarch64-linux"] as const;

export type Platform = (typeof platforms)[number];

// What {target} stands for on each platform, best first: static musl builds just run.
const targets: Record<Platform, ReadonlyArray<string>> = {
	"x86_64-linux": ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"],
	"aarch64-linux": ["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"],
};

/**
 * The asset names a release's template can mean on `platform` for the tag
 * `tag`, best first: `{version}` is the tag without a leading "v", `{target}`
 * a Rust target triple.
 */
export const assetNames = (release: Release, tag: string, platform: Platform) => [
	...new Set(
		targets[platform].map((target) =>
			release.asset.replaceAll("{version}", tag.replace(/^v/, "")).replaceAll("{target}", target),
		),
	),
];

/** Whether a pin still answers its release's declaration: the same asset template and binary. */
export const pinFits = (pin: ReleasePin, release: Release) =>
	pin.asset === release.asset && pin.bin === release.bin;

// The node a root input points at in a lock, if it has its own.
const rootNode = (lock: InputsLock, input: string) =>
	Option.fromUndefinedOr(lock.nodes[lock.root]?.inputs?.[input]).pipe(
		Option.filter(Predicate.isString),
	);

/**
 * Adds to `pinned` the root inputs that `defaults` has and it lacks, with the
 * nodes they bring, renamed when a name is taken. Inputs it has keep their
 * pins. Returns the lock and the inputs it added.
 */
export const mergeInputs = (pinned: InputsLock, defaults: InputsLock) => {
	const root = pinned.nodes[pinned.root];
	const defaultRoot = defaults.nodes[defaults.root];

	const missing = Object.keys(defaultRoot?.inputs ?? {}).filter(
		(input) => root?.inputs?.[input] === undefined,
	);

	const nodes = new Map<string, LockNode>(Object.entries(pinned.nodes));
	const renamed = new Map<string, string>();

	// The name a default node gets in the merged lock: its own, unless another node holds it.
	const place = (name: string): string => {
		const known = renamed.get(name);

		if (known !== undefined) return known;

		const node = defaults.nodes[name];

		const free = (candidate: string, n: number): string =>
			nodes.has(candidate) ? free(`${name}_${n}`, n + 1) : candidate;

		const target = free(name, 2);

		renamed.set(name, target);

		const inputs = Object.fromEntries(
			Object.entries(node?.inputs ?? {}).map(([input, ref]) => [
				input,
				Predicate.isString(ref) ? place(ref) : ref,
			]),
		);

		nodes.set(target, node?.inputs === undefined ? (node ?? {}) : { ...node, inputs });

		return target;
	};

	const added = missing.flatMap((input) =>
		Option.toArray(Option.map(rootNode(defaults, input), (node) => [input, place(node)] as const)),
	);

	nodes.set(pinned.root, {
		...root,
		inputs: { ...root?.inputs, ...Object.fromEntries(added) },
	});

	return {
		lock: {
			nodes: Object.fromEntries(nodes),
			root: pinned.root,
			version: pinned.version,
		} satisfies InputsLock,
		added: added.map(([input]) => input),
	};
};

// A root input's revision as the operator reads it: a short commit and its date.
const describeRevision = (lock: InputsLock, input: string) =>
	Option.flatMap(rootNode(lock, input), (node) => {
		const locked = lock.nodes[node]?.locked ?? {};
		const rev = String(locked.rev ?? locked.narHash ?? "?").slice(0, 7);

		const date = Option.map(
			Option.filter(Option.fromUndefinedOr(locked.lastModified), Predicate.isNumber),
			(seconds) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(seconds * 1000)),
		);

		return Option.some(
			Option.match(date, { onNone: () => rev, onSome: (day) => `${rev} (${day})` }),
		);
	});

/** A line per root input whose revision differs between two locks, such as "nixpkgs: 7fc6f2c (2026-09-28) → 1a2b3c4 (2026-10-05)". */
export const inputChanges = (before: InputsLock, after: InputsLock) =>
	Object.keys(after.nodes[after.root]?.inputs ?? {}).flatMap((input) => {
		const old = Option.getOrElse(describeRevision(before, input), () => "new");
		const now = Option.getOrElse(describeRevision(after, input), () => "gone");

		return old === now ? [] : [`${input}: ${old} → ${now}`];
	});
