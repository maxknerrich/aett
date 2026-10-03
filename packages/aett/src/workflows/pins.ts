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
import type { Release, Source } from "../domain/packages.ts";
import type { State } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";
import { loadFleet, readState } from "./load.ts";
import { thisMac, upgradeApps } from "./mac.ts";

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
 * A release's latest version, or the version `tag`, with the asset its
 * template names on each platform and the asset's hash. Platforms without
 * such an asset are left out; a release with none at all is an error.
 */
const resolveRelease = Effect.fn("resolveRelease")(function* (release: Release, tag?: string) {
	const github = yield* GitHub;
	const engine = yield* Engine;

	const published = yield* tag === undefined
		? github.latestRelease(release.github)
		: github.release(release.github, tag);

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
			message: `${release.github} ${published.tag} has no asset named like ${release.asset}.`,
		});
	}

	return {
		asset: release.asset,
		bin: release.bin,
		version: published.tag,
		assets: Object.fromEntries(assets.flat()),
	} satisfies ReleasePin;
});

// The flake input each package source is.
const sourceInputs: Record<Source, string> = {
	"llm-agents": "llm-agents",
	nixpkgs: "nixpkgs",
	unstable: "nixpkgs-unstable",
};

/**
 * Picks a source for each package name `pinned` lacks, on the platform of a
 * machine that lists it: llm-agents.nix, else nixpkgs, else nixpkgs unstable.
 * Names only on machines whose platform aett doesn't know yet wait. A name no
 * source has is an error.
 */
const pickSources = Effect.fn("pickSources")(function* (fleet: Fleet, state: State, pins: Pins) {
	const engine = yield* Engine;

	const wanted = fleet.machines.flatMap(({ name, packages }) => {
		const platform = state.machines.get(name)?.platform;

		return platform === undefined
			? []
			: packages
					.filter((pkg) => pins.packages[pkg] === undefined)
					.map((pkg) => ({ pkg, platform }));
	});

	const byPlatform = Map.groupBy(
		[...new Map(wanted.map((want) => [want.pkg, want])).values()],
		({ platform }) => platform,
	);

	const found = yield* Effect.forEach(byPlatform, ([platform, names]) =>
		engine
			.packageSources(
				pins.inputs,
				platform,
				names.map(({ pkg }) => pkg),
			)
			.pipe(Effect.map((sources) => ({ platform, sources: [...sources] }))),
	);

	const missing = found.flatMap(({ platform, sources }) =>
		sources.flatMap(([name, source]) => (Option.isNone(source) ? [`${name} (${platform})`] : [])),
	);

	if (missing.length > 0) {
		return yield* new PinsError({
			message: `No source has ${missing.join(", ")}: not llm-agents.nix, nixpkgs or nixpkgs unstable. Check the name, or declare a release().`,
		});
	}

	return Object.fromEntries(
		found.flatMap(({ sources }) =>
			sources.flatMap(([name, source]) =>
				Option.toArray(Option.map(source, (picked) => [name, picked] as const)),
			),
		),
	);
});

/**
 * Brings the fleet's pins up to what aett and fleet.ts need, and returns
 * them: a fleet without pins starts from aett's tested ones, inputs a newer
 * aett added are pinned at their tested defaults, release sources without a
 * fitting pin are pinned at their latest version, new package names get a
 * source, and pins of releases and packages no longer declared go. Existing
 * pins never move here; aett update moves them.
 */
export const completePins = Effect.fn("completePins")(function* (
	root: string,
	fleet: Fleet,
	state: State,
) {
	const engine = yield* Engine;
	const recorded = yield* readPins(root);
	const defaults = yield* engine.defaultInputs;

	const start = Option.getOrElse(recorded, (): Pins => ({
		inputs: defaults,
		releases: {},
		packages: {},
	}));

	const { lock, added } = mergeInputs(start.inputs, defaults);
	const declared = declaredReleases(fleet);

	// The platforms of the machines that list each release, which its pin must have an asset for.
	const needed = (release: Release) =>
		new Set(
			fleet.machines.flatMap(({ name, releases: listed }) => {
				const platform = state.machines.get(name)?.platform;

				return platform !== undefined && listed.some(({ github }) => github === release.github)
					? [platform]
					: [];
			}),
		);

	const unpinned = declared.filter((release) =>
		Option.match(Option.fromUndefinedOr(start.releases[release.github]), {
			onNone: () => true,
			onSome: (pin) => !pinFits(pin, release),
		}),
	);

	// A pin made before a machine on another platform listed it gains that platform's asset at the
	// same version.
	const widened = yield* Effect.forEach(
		declared.flatMap((release) =>
			Option.toArray(
				Option.filter(
					Option.fromUndefinedOr(start.releases[release.github]),
					(pin) =>
						pinFits(pin, release) &&
						[...needed(release)].some((platform) => pin.assets[platform] === undefined),
				).pipe(Option.map((pin) => ({ release, pin }))),
			),
		),
		({ release, pin }) =>
			resolveRelease(release, pin.version).pipe(
				Effect.tap(() => Console.log(`Pinned ${release.bin} ${pin.version} for more platforms.`)),
				Effect.map((wider) => [release.github, wider] as const),
			),
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
			const pin = new Map([...widened, ...pinned]).get(github) ?? start.releases[github];

			return pin === undefined ? [] : [[github, pin] as const];
		}),
	);

	const picked = yield* pickSources(fleet, state, {
		inputs: lock,
		releases: start.releases,
		packages: start.packages,
	});

	const names = new Set(fleet.machines.flatMap(({ packages }) => packages));

	const packages = Object.fromEntries(
		Object.entries({ ...start.packages, ...picked })
			.filter(([name]) => names.has(name))
			.toSorted(([a], [b]) => a.localeCompare(b)),
	);

	const pins = { inputs: lock, releases, packages } satisfies Pins;
	const dropped = Object.keys(start.releases).filter((github) => releases[github] === undefined);
	const forgotten = Object.keys(start.packages).filter((name) => !names.has(name));
	const newlyPicked = Object.entries(picked);

	if (
		Option.isNone(recorded) ||
		added.length > 0 ||
		pinned.length > 0 ||
		widened.length > 0 ||
		dropped.length > 0 ||
		forgotten.length > 0 ||
		newlyPicked.length > 0
	) {
		yield* writePins(root, pins);
	}

	if (Option.isNone(recorded)) yield* Console.log("Wrote state/pins.json from aett's tested pins.");

	if (added.length > 0) {
		yield* Console.log(`Pinned ${added.join(", ")} at aett's tested revisions.`);
	}

	yield* Effect.forEach(
		Map.groupBy(newlyPicked, ([, source]) => source),
		([source, picks]) =>
			Console.log(`Pinned ${picks.map(([name]) => name).join(", ")} from ${source}.`),
	);

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
	const defaults = yield* engine.defaultInputs;
	const inputs = Object.keys(defaults.nodes[defaults.root]?.inputs ?? {});
	const declared = declaredReleases(fleet);
	const pins = yield* completePins(root, fleet, yield* readState(root, fleet));

	// A package moves with the input of its source.
	const inputOf = (name: string) =>
		inputs.includes(name)
			? name
			: Option.getOrUndefined(
					Option.map(Option.fromUndefinedOr(pins.packages[name]), (source) => sourceInputs[source]),
				);

	const unknown = names.filter(
		(name) =>
			inputOf(name) === undefined &&
			!declared.some(({ github, bin }) => name === github || name === bin),
	);

	if (unknown.length > 0) {
		return yield* new PinsError({
			message: `aett pins no ${unknown.join(", ")}. It pins the inputs ${inputs.join(", ")}, the releases ${declared.map(({ bin }) => bin).join(", ") || "(none)"} and the packages fleet.ts lists.`,
		});
	}

	const everything = names.length === 0;

	const movedInputs = everything
		? inputs
		: [...new Set(names.flatMap((name) => Option.toArray(Option.fromUndefinedOr(inputOf(name)))))];

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
		...releases.flatMap(({ release, pin, before }) => {
			if (before?.version !== pin.version) {
				return [`${release.bin}: ${before?.version ?? "new"} → ${pin.version}`];
			}

			// The publisher replaced or added an asset under the same tag.
			return JSON.stringify(before.assets) === JSON.stringify(pin.assets)
				? []
				: [`${release.bin}: ${pin.version}, its assets changed`];
		}),
	];

	yield* writePins(root, {
		inputs: lock,
		releases: {
			...pins.releases,
			...Object.fromEntries(releases.map(({ release, pin }) => [release.github, pin] as const)),
		},
		packages: pins.packages,
	});

	yield* Console.log(
		changes.length === 0
			? "Everything is up to date."
			: `${changes.join("\n")}\nApply to build the machines from the new pins.`,
	);

	// Apps come unpinned; updating the Mac aett runs on upgrades them.
	const mac = yield* thisMac(fleet, Option.none());

	return yield* Effect.forEach(Option.toArray(mac), upgradeApps, { discard: true });
});
