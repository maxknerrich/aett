import { Console, Effect, FileSystem, Match, Option, Path, Schema } from "effect";
import { GitHub } from "../adapters/github.ts";
import type { Fleet } from "../domain/fleet.ts";
import {
	assetNames,
	familyOf,
	inputChanges,
	mergeInputs,
	pinFits,
	Pins,
	platforms,
	type ReleasePin,
	sourceOf,
} from "../domain/pins.ts";
import { explicitSource, type Family, type Release, type Source } from "../domain/packages.ts";
import { Homebrew } from "../adapters/homebrew.ts";
import type { State } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";
import { loadFleet, readState } from "./load.ts";
import { emitAsIs } from "./compile.ts";
import { thisMac, upgradeApps } from "./mac.ts";
import { writeRegistries } from "./registries.ts";

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

// The flake inputs a package comes from: its source's, and for nixpkgs that of each channel the
// machines listing it are on. Homebrew's come unpinned, and aett update upgrades them on the Mac.
const inputsOf = (fleet: Fleet, name: string, source: Source): ReadonlyArray<string> =>
	Match.value(source).pipe(
		Match.when("llm-agents", () => ["llm-agents"]),
		Match.when("unstable", () => ["nixpkgs-unstable"]),
		Match.whenOr("cask", "brew", () => []),
		Match.orElse(() => [
			...new Set(
				fleet.machines.flatMap(({ packages, channel }) =>
					packages.includes(name) ? [channel === "stable" ? "nixpkgs" : "nixpkgs-unstable"] : [],
				),
			),
		]),
	);

/**
 * Picks a source for each package name the pins lack on Linux or on Macs, on
 * the platform of a machine there that lists it. On Linux: llm-agents.nix,
 * else nixpkgs, else nixpkgs unstable. On a Mac a Homebrew cask comes first,
 * so an app lands in /Applications and updates itself, and a Homebrew formula
 * last. Names led by their source need no pick, and names only on machines
 * whose platform aett doesn't know yet wait. A name no source has is an
 * error.
 */
const pickSources = Effect.fn("pickSources")(function* (fleet: Fleet, state: State, pins: Pins) {
	const engine = yield* Engine;
	const homebrew = yield* Homebrew;

	const wanted = fleet.machines.flatMap(({ name, packages, channel }) => {
		const platform = state.machines.get(name)?.platform;

		return platform === undefined
			? []
			: packages.flatMap((pkg) =>
					Option.isNone(explicitSource(pkg)) &&
					pins.packages[pkg]?.[familyOf(platform)] === undefined
						? [{ pkg, platform, channel }]
						: [],
				);
	});

	// Looked up once per name and family, for the first machine that lists it, in one evaluation per platform and channel.
	const byTarget = Map.groupBy(
		[...new Map(wanted.map((want) => [`${want.pkg} ${familyOf(want.platform)}`, want])).values()],
		({ platform, channel }) => `${platform} ${channel}`,
	);

	const groups = [...byTarget.values()].flatMap((names) =>
		Option.toArray(
			Option.map(Option.fromUndefinedOr(names[0]), ({ platform, channel }) => ({
				platform,
				channel,
				names: names.map(({ pkg }) => pkg),
			})),
		),
	);

	const found = yield* Effect.forEach(groups, ({ platform, channel, names }) =>
		Effect.gen(function* () {
			const mac = familyOf(platform) === "darwin";
			const casks = mac ? yield* homebrew.existing("cask", names) : new Set<string>();
			const rest = names.filter((name) => !casks.has(name));
			const nix = yield* engine.packageSources(pins.inputs, platform, channel, rest);

			const fromNix = (name: string): Option.Option<Source> =>
				Option.flatten(Option.fromUndefinedOr(nix.get(name)));

			const formulae = mac
				? yield* homebrew.existing(
						"formula",
						rest.filter((name) => Option.isNone(fromNix(name))),
					)
				: new Set<string>();

			const sources = names.map((name) => {
				const source: Option.Option<Source> = casks.has(name)
					? Option.some("cask")
					: Option.orElse(fromNix(name), () =>
							formulae.has(name) ? Option.some("brew") : Option.none(),
						);

				return [name, source] as const;
			});

			return { platform, sources };
		}),
	);

	const missing = found.flatMap(({ platform, sources }) =>
		sources.flatMap(([name, source]) => (Option.isNone(source) ? [`${name} (${platform})`] : [])),
	);

	if (missing.length > 0) {
		return yield* new PinsError({
			message: `No source has ${missing.join(", ")}: not llm-agents.nix, nixpkgs, nixpkgs unstable, nor on a Mac a Homebrew cask or formula. Check the name, lead it by its source, such as "brew.owner/tap/name", or declare a release().`,
		});
	}

	return found.flatMap(({ platform, sources }) =>
		sources.flatMap(([name, source]) =>
			Option.toArray(
				Option.map(source, (picked) => ({ name, family: familyOf(platform), source: picked })),
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

	// Names led by their source need no pin.
	const names = new Set(
		fleet.machines.flatMap(({ packages }) =>
			packages.filter((pkg) => Option.isNone(explicitSource(pkg))),
		),
	);

	const fresh = Map.groupBy(picked, ({ name }) => name);

	const packages = Object.fromEntries(
		[...names]
			.toSorted()
			.map((name) => [
				name,
				Object.fromEntries([
					...Object.entries(start.packages[name] ?? {}),
					...(fresh.get(name) ?? []).map(({ family, source }) => [family, source] as const),
				]),
			]),
	);

	const pins = { inputs: lock, releases, packages } satisfies Pins;
	const dropped = Object.keys(start.releases).filter((github) => releases[github] === undefined);
	const forgotten = Object.keys(start.packages).filter((name) => !names.has(name));
	const newlyPicked = picked;

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
		Map.groupBy(newlyPicked, ({ source, family }) => `${source} ${family}`),
		([, picks]) =>
			Console.log(
				`Pinned ${picks.map(({ name }) => name).join(", ")} from ${picks[0]?.source ?? ""}${picks[0]?.family === "darwin" ? " on Macs" : ""}.`,
			),
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

	// A package moves with the inputs it comes from, on Linux and on Macs.
	const inputsFor = (name: string): ReadonlyArray<string> => {
		if (inputs.includes(name)) return [name];

		const families: ReadonlyArray<Family> = ["linux", "darwin"];

		return [
			...new Set(
				families.flatMap((family) =>
					Option.match(sourceOf(pins, name, family), {
						onNone: () => [],
						onSome: ({ source }) => inputsOf(fleet, name, source),
					}),
				),
			),
		];
	};

	const unknown = names.filter(
		(name) =>
			inputsFor(name).length === 0 &&
			!declared.some(({ github, bin }) => name === github || name === bin),
	);

	if (unknown.length > 0) {
		return yield* new PinsError({
			message: `aett pins no ${unknown.join(", ")}. It pins the inputs ${inputs.join(", ")}, the releases ${declared.map(({ bin }) => bin).join(", ") || "(none)"} and the packages fleet.ts lists.`,
		});
	}

	const everything = names.length === 0;

	const movedInputs = everything ? inputs : [...new Set(names.flatMap(inputsFor))];

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

	const updated: Pins = {
		inputs: lock,
		releases: {
			...pins.releases,
			...Object.fromEntries(releases.map(({ release, pin }) => [release.github, pin] as const)),
		},
		packages: pins.packages,
	};

	yield* writePins(root, updated);
	yield* writeRegistries(root, updated);

	yield* Console.log(
		changes.length === 0
			? "Everything is up to date."
			: `${changes.join("\n")}\nApply to build the machines from the new pins.`,
	);

	// Apps come unpinned; updating the Mac aett runs on upgrades them, once it was applied.
	const mac = yield* thisMac(fleet, Option.none(), false);

	return yield* Effect.forEach(
		Option.toArray(mac),
		({ name }) =>
			Effect.gen(function* () {
				const { build } = yield* emitAsIs(root);

				if (!build.macs.includes(name)) {
					return yield* Console.log(`Apply ${name} once before aett update upgrades its apps.`);
				}

				return yield* upgradeApps(name, yield* engine.brewfile(build, name));
			}),
		{ discard: true },
	);
});
