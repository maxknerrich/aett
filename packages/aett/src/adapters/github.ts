import { Config, Context, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
	message: Schema.String,
}) {}

// The part of GitHub's latest-release response aett reads.
const LatestRelease = Schema.Struct({
	tag_name: Schema.String,
	assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
});

/** A published release: its tag and the URL of each asset by name. */
export interface PublishedRelease {
	readonly tag: string;
	readonly assets: ReadonlyMap<string, string>;
}

/** GitHub's REST API. GITHUB_TOKEN, when set, lifts the anonymous rate limit. */
export class GitHub extends Context.Service<
	GitHub,
	{
		/** The repository's latest release, "owner/name". */
		readonly latestRelease: (repository: string) => Effect.Effect<PublishedRelease, GitHubError>;
	}
>()("aett/adapters/GitHub") {
	static readonly layer = Layer.effect(
		GitHub,
		Effect.gen(function* () {
			const token = yield* Config.option(Config.Redacted("GITHUB_TOKEN")).pipe(Effect.orDie);

			const client = (yield* HttpClient.HttpClient).pipe(
				HttpClient.mapRequest((request) =>
					Option.match(token, {
						onNone: () => request,
						onSome: (value) => HttpClientRequest.bearerToken(request, value),
					}).pipe(
						HttpClientRequest.prependUrl("https://api.github.com"),
						HttpClientRequest.acceptJson,
					),
				),
				HttpClient.filterStatusOk,
			);

			const latestRelease = Effect.fn("GitHub.latestRelease")(function* (repository: string) {
				const release = yield* client.get(`/repos/${repository}/releases/latest`).pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(LatestRelease)),
					Effect.mapError(
						(cause) =>
							new GitHubError({
								message: `Could not read ${repository}'s latest release from GitHub: ${cause.message}`,
							}),
					),
				);

				return {
					tag: release.tag_name,
					assets: new Map(
						release.assets.map(({ name, browser_download_url }) => [name, browser_download_url]),
					),
				} satisfies PublishedRelease;
			});

			return GitHub.of({ latestRelease });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}
