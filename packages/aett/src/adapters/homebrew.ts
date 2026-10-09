import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

export class HomebrewError extends Schema.TaggedError<HomebrewError>()("HomebrewError", {
	message: Schema.String,
}) {}

/** What Homebrew installs: a cask, such as a Mac app, or a formula. */
export type HomebrewKind = "cask" | "formula";

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
	}
>()("aett/adapters/Homebrew") {
	static readonly layer = Layer.effect(
		Homebrew,
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient;

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

			return Homebrew.of({ existing });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}
