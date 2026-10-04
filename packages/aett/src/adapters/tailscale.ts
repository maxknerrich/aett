import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientError,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/http";

export class TailscaleError extends Schema.TaggedError<TailscaleError>()("TailscaleError", {
	message: Schema.String,
}) {}

/** The OAuth client that lets aett edit the tailnet's policy, which aett keeps as the secret tailscale/oauth. */
export const OAuthClient = Schema.Struct({
	id: Schema.NonEmptyString,
	secret: Schema.String.check(
		Schema.isPattern(/^tskey-client-\S+$/, { expected: "an OAuth client secret, tskey-client-…" }),
	),
});

export interface OAuthClient extends Schema.Schema.Type<typeof OAuthClient> {}

/** The tailnet's policy as HuJSON, with the version an edit has to start from. */
export interface PolicyFile {
	readonly text: string;
	readonly etag: string;
}

const Token = Schema.Struct({
	access_token: Schema.String,
	scope: Schema.optionalKey(Schema.String),
});

// What the API says about a call it refused.
const Refusal = Schema.Struct({ message: Schema.String });

// Fails with what a failed call says, with the API's own message where it gave one.
const failure = (doing: string) => (cause: { readonly message: string }) =>
	Effect.flatMap(
		HttpClientError.isHttpClientError(cause) && cause.response !== undefined
			? cause.response.json.pipe(
					Effect.map(Schema.decodeUnknownOption(Refusal)),
					Effect.orElseSucceed(() => Option.none()),
				)
			: Effect.succeed(Option.none()),
		(refusal) =>
			Effect.fail(
				new TailscaleError({
					message: `Could not ${doing} through Tailscale's API: ${Option.match(refusal, {
						onNone: () => cause.message,
						onSome: ({ message }) => message,
					})}`,
				}),
			),
	);

/** The scope aett's OAuth client needs: writing the policy file. */
export const policyScope = "policy_file";

/**
 * Tailscale's API, as the fleet's OAuth client: it reads the tailnet's
 * policy and writes it back with what the fleet needs.
 */
export class Tailscale extends Context.Service<
	Tailscale,
	{
		/** Checks that `client` signs in with the scope aett needs, before aett keeps it. */
		readonly check: (client: OAuthClient) => Effect.Effect<void, TailscaleError>;
		readonly policy: (client: OAuthClient) => Effect.Effect<PolicyFile, TailscaleError>;
		/** Replaces the policy with `text`, unless it changed since the version `etag` names. */
		readonly setPolicy: (
			client: OAuthClient,
			text: string,
			etag: string,
		) => Effect.Effect<void, TailscaleError>;
	}
>()("aett/adapters/Tailscale") {
	static readonly layer = Layer.effect(
		Tailscale,
		Effect.gen(function* () {
			const http = (yield* HttpClient.HttpClient).pipe(
				HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.tailscale.com/api/v2")),
				HttpClient.filterStatusOk,
			);

			// The access token the OAuth client exchanges its secret for, with the scopes it grants.
			const token = (client: OAuthClient) =>
				http
					.execute(
						HttpClientRequest.post("/oauth/token").pipe(
							HttpClientRequest.bodyUrlParams({
								grant_type: "client_credentials",
								client_id: client.id,
								client_secret: client.secret,
							}),
						),
					)
					.pipe(
						Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
						Effect.catch(failure("sign in with the OAuth client")),
					);

			// A client authorized with the OAuth client's access token.
			const authorized = Effect.fn("Tailscale.authorized")(function* (client: OAuthClient) {
				const { access_token } = yield* token(client);

				return http.pipe(
					HttpClient.mapRequest((request) =>
						HttpClientRequest.bearerToken(request, Redacted.make(access_token)),
					),
				);
			});

			const check = Effect.fn("Tailscale.check")(function* (client: OAuthClient) {
				const granted = (yield* token(client)).scope?.split(" ") ?? [];

				if (!granted.includes(policyScope)) {
					return yield* new TailscaleError({
						message: "The OAuth client can't write the policy. Make one with Policy File: Write.",
					});
				}

				return yield* Effect.void;
			});

			const policy = Effect.fn("Tailscale.policy")(function* (client: OAuthClient) {
				const api = yield* authorized(client);

				return yield* api
					.execute(
						HttpClientRequest.get("/tailnet/-/acl").pipe(
							HttpClientRequest.setHeader("Accept", "application/hujson"),
						),
					)
					.pipe(
						Effect.flatMap((response) =>
							Effect.map(response.text, (text): PolicyFile => ({
								text,
								etag: response.headers["etag"] ?? "",
							})),
						),
						Effect.catch(failure("read the tailnet's policy")),
					);
			});

			const setPolicy = Effect.fn("Tailscale.setPolicy")(function* (
				client: OAuthClient,
				text: string,
				etag: string,
			) {
				const api = yield* authorized(client);

				yield* api
					.execute(
						HttpClientRequest.post("/tailnet/-/acl").pipe(
							HttpClientRequest.setHeader("If-Match", etag),
							HttpClientRequest.bodyText(text, "application/hujson"),
						),
					)
					.pipe(Effect.catch(failure("update the tailnet's policy")));
			});

			return Tailscale.of({ check, policy, setPolicy });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}
