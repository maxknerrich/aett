import { homedir } from "node:os";
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

export class HomebrewError extends Schema.TaggedError<HomebrewError>()("HomebrewError", {
	message: Schema.String,
}) {}

/** What Homebrew installs: a cask, such as a Mac app, or a formula. */
export type HomebrewKind = "cask" | "formula";

/** Every cask and formula name in Homebrew's catalog. */
export interface HomebrewNames {
	readonly casks: ReadonlyArray<string>;
	readonly formulae: ReadonlyArray<string>;
}

// The catalog's names as aett keeps them between runs, with when it fetched them.
const Cached = Schema.fromJsonString(
	Schema.Struct({
		fetched: Schema.Number,
		casks: Schema.Array(Schema.String),
		formulae: Schema.Array(Schema.String),
	}),
);

// How long aett reuses the catalog's names: they change daily, and the catalog is about 50 MB.
const freshFor = 86_400_000;

/**
 * Homebrew's catalog through its public JSON API, which needs no Homebrew on
 * the controller: which casks and formulae exist. Taps' aren't in it.
 */
export class Homebrew extends Context.Service<
	Homebrew,
	{
		/** Those of `names` that Homebrew has as `kind`. */
		readonly existing: (
			kind: HomebrewKind,
			names: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlySet<string>, HomebrewError>;
		/** Every name in the catalog, fetched at most once a day. */
		readonly catalog: Effect.Effect<HomebrewNames, HomebrewError>;
	}
>()("aett/adapters/Homebrew") {
	static readonly layer = Layer.effect(
		Homebrew,
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const cacheFile = path.join(homedir(), ".cache", "aett", "homebrew.json");

			// Whether Homebrew has `name` as `kind`: its page exists, or answers 404.
			const has = (kind: HomebrewKind, name: string) =>
				http.get(`https://formulae.brew.sh/api/${kind}/${encodeURIComponent(name)}.json`).pipe(
					Effect.flatMap((response) =>
						response.status === 200 || response.status === 404
							? Effect.succeed(response.status === 200)
							: Effect.fail({ message: `it answered ${response.status}` }),
					),
					Effect.mapError(
						(error) =>
							new HomebrewError({
								message: `Could not look up ${name} in Homebrew's catalog: ${error.message}`,
							}),
					),
				);

			const existing = Effect.fn("Homebrew.existing")(function* (
				kind: HomebrewKind,
				names: ReadonlyArray<string>,
			) {
				const found = yield* Effect.forEach(
					names,
					(name) => Effect.map(has(kind, name), (exists) => (exists ? [name] : [])),
					{ concurrency: 8 },
				);

				return new Set(found.flat());
			});

			// The names of every `kind` in the catalog.
			const listed = <A>(kind: HomebrewKind, item: Schema.Codec<A>, name: (item: A) => string) =>
				HttpClient.filterStatusOk(http)
					.get(`https://formulae.brew.sh/api/${kind}.json`)
					.pipe(
						Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(item))),
						Effect.map((items) => items.map(name)),
						Effect.mapError(
							(error) =>
								new HomebrewError({
									message: `Could not fetch Homebrew's ${kind} catalog: ${error.message}`,
								}),
						),
					);

			const catalog = Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;

				const cached = yield* fs
					.readFileString(cacheFile)
					.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Cached)), Effect.option);

				const fresh = Option.filter(cached, ({ fetched }) => now - fetched < freshFor);

				if (Option.isSome(fresh)) return fresh.value;

				const casks = yield* listed(
					"cask",
					Schema.Struct({ token: Schema.String }),
					({ token }) => token,
				);

				const formulae = yield* listed(
					"formula",
					Schema.Struct({ name: Schema.String }),
					({ name }) => name,
				);

				// A catalog aett can't keep is fetched again next time.
				yield* fs
					.makeDirectory(path.dirname(cacheFile), { recursive: true })
					.pipe(
						Effect.andThen(
							fs.writeFileString(cacheFile, JSON.stringify({ fetched: now, casks, formulae })),
						),
						Effect.ignore,
					);

				return { casks, formulae } satisfies HomebrewNames;
			});

			return Homebrew.of({ existing, catalog });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}
