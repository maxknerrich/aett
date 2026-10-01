import { Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { GitHub } from "../adapters/github.ts";
import type { Fleet } from "../domain/fleet.ts";
import {
	assetNames,
	inputChanges,
	mergeInputs,
	pinFits,
	Pins,
	platforms,
	type ReleasePin,
} from "../domain/pins.ts";
import type { Release } from "../domain/stacks.ts";
import { Engine } from "../engine/engine.ts";
import { loadFleet } from "./load.ts";

export class PinsError extends Schema.TaggedError<PinsError>()("PinsError", {
	message: Schema.String,
}) {}

const PinsFile = Schema.fromJsonString(Pins);

// Where the fleet keeps its pins.
const pinsFile = Effect.map(
	Effect.service(Path.Path),
	(path) => (root: string) => path.join(root, "state", "pins.json"),
);

/** state/pins.json, or none when the fleet has no pins yet. */
export const readPins = Effect.fn("readPins")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = (yield* pinsFile)(root);

	if (!(yield* fs.exists(file))) return Option.none<Pins>();

	return Option.some(
		yield* fs.readFileString(file).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(PinsFile)),
			Effect.catchTag("SchemaError", (error) =>
				Effect.fail(new PinsError({ message: `state/pins.json is invalid: ${error.message}` })),
			),
		),
	);
});

/** Writes state/pins.json. */
export const writePins = Effect.fn("writePins")(function* (root: string, pins: Pins) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString((yield* pinsFile)(root), `${JSON.stringify(pins, null, "\t")}\n`);
});

// Every release source the fleet declares, one per repository.
const declaredReleases = (fleet: Fleet) => [
	...new Map(
		fleet.machines.flatMap(({ releases }) =>
			releases.map((release) => [release.github, release] as const),
		),
	).values(),
];

/**
 * A release's latest version, with the asset its template names on each
 * platform and the asset's hash. Platforms without such an asset are left
 * out; a release with none at all is an error.
 */
const resolveRelease = Effect.fn("resolveRelease")(function* (release: Release) {
	const github = yield* GitHub;
	const engine = yield* Engine;
	const published = yield* github.latestRelease(release.github);

	const assets = yield* Effect.forEach(platforms, (platform) =>
		Option.match(
			Option.fromUndefinedOr(
				assetNames(release, published.tag, platform).find((name) => published.assets.has(name)),
			),
			{
				onNone: () => Effect.succeed([]),
				onSome: (name) => {
					const url = published.assets.get(name) ?? "";

					return Effect.map(engine.prefetch(url), (hash) => [[platform, { url, hash }] as const]);
				},
			},
		),
	);

	if (assets.flat().length === 0) {
		return yield* new PinsError({
			message: `${release.github} ${published.tag} has no Linux asset named like ${release.asset}.`,
		});
	}

	return {
		asset: release.asset,
		bin: release.bin,
		version: published.tag,
		assets: Object.fromEntries(assets.flat()),
	} satisfies ReleasePin;
});

/**
 * Brings the fleet's pins up to what aett and fleet.ts need, and returns
 * them: a fleet without pins starts from aett's tested ones, inputs a newer
 * aett added are pinned at their tested defaults, release sources without a
 * fitting pin are pinned at their latest version, and pins of releases no
 * longer declared go. Existing pins never move here; aett update moves them.
 */
export const completePins = Effect.fn("completePins")(function* (root: string, fleet: Fleet) {
	const engine = yield* Engine;
	const recorded = yield* readPins(root);
	const defaults = yield* engine.defaultInputs;
	const start = Option.getOrElse(recorded, (): Pins => ({ inputs: defaults, releases: {} }));
	const { lock, added } = mergeInputs(start.inputs, defaults);
	const declared = declaredReleases(fleet);

	const unpinned = declared.filter((release) =>
		Option.match(Option.fromUndefinedOr(start.releases[release.github]), {
			onNone: () => true,
			onSome: (pin) => !pinFits(pin, release),
		}),
	);

	const pinned = yield* Effect.forEach(unpinned, (release) =>
		resolveRelease(release).pipe(
			Effect.tap((pin) =>
				Console.log(`Pinned ${release.bin} from ${release.github} at ${pin.version}.`),
			),
			Effect.map((pin) => [release.github, pin] as const),
		),
	);

	const releases = Object.fromEntries(
		declared.flatMap(({ github }) => {
			const pin = new Map(pinned).get(github) ?? start.releases[github];

			return pin === undefined ? [] : [[github, pin] as const];
		}),
	);

	const pins = { inputs: lock, releases } satisfies Pins;
	const dropped = Object.keys(start.releases).filter((github) => releases[github] === undefined);

	if (Option.isNone(recorded) || added.length > 0 || pinned.length > 0 || dropped.length > 0) {
		yield* writePins(root, pins);
	}

	if (Option.isNone(recorded)) yield* Console.log("Wrote state/pins.json from aett's tested pins.");

	if (added.length > 0) {
		yield* Console.log(`Pinned ${added.join(", ")} at aett's tested revisions.`);
	}

	return pins;
});

/**
 * Moves the fleet's pins forward, the named ones or all of them, and prints
 * what changed: inputs by name to their latest revisions, release sources by
 * repository or binary to their latest versions. It touches nothing but the
 * pins: no machine, identity or secret.
 */
export const update = Effect.fn("update")(function* (root: string, names: ReadonlyArray<string>) {
	const engine = yield* Engine;
	const fleet = yield* loadFleet(root);
	const pins = yield* completePins(root, fleet);
	const inputs = Object.keys(pins.inputs.nodes[pins.inputs.root]?.inputs ?? {});
	const declared = declaredReleases(fleet);

	const unknown = names.filter(
		(name) =>
			!inputs.includes(name) &&
			!declared.some(({ github, bin }) => name === github || name === bin),
	);

	if (unknown.length > 0) {
		return yield* new PinsError({
			message: `aett pins no ${unknown.join(", ")}. It pins ${[...inputs, ...declared.map(({ bin }) => bin)].join(", ")}.`,
		});
	}

	const everything = names.length === 0;
	const movedInputs = everything ? inputs : names.filter((name) => inputs.includes(name));

	const moved = declared.filter(
		({ github, bin }) => everything || names.includes(github) || names.includes(bin),
	);

	if (movedInputs.length > 0) yield* Console.log(`Updating ${movedInputs.join(", ")}…`);

	const lock =
		movedInputs.length > 0
			? yield* engine.updateInputs(pins.inputs, everything ? [] : movedInputs)
			: pins.inputs;

	const releases = yield* Effect.forEach(moved, (release) =>
		Console.log(`Checking ${release.github}…`).pipe(
			Effect.andThen(resolveRelease(release)),
			Effect.map((pin) => ({ release, pin, before: pins.releases[release.github] })),
		),
	);

	const changes = [
		...inputChanges(pins.inputs, lock),
		...releases.flatMap(({ release, pin, before }) =>
			before?.version === pin.version
				? []
				: [`${release.bin}: ${before?.version ?? "new"} → ${pin.version}`],
		),
	];

	yield* writePins(root, {
		inputs: lock,
		releases: {
			...pins.releases,
			...Object.fromEntries(releases.map(({ release, pin }) => [release.github, pin] as const)),
		},
	});

	return yield* Console.log(
		changes.length === 0
			? "Everything is up to date."
			: `${changes.join("\n")}\nApply to build the machines from the new pins.`,
	);
});
