import { isIP } from "node:net";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class TailscaleError extends Schema.TaggedError<TailscaleError>()("TailscaleError", {
	message: Schema.String,
}) {}

/** The fleet's Tailscale OAuth client, which aett keeps as the secret tailscale/oauth. */
export const OAuthClient = Schema.Struct({
	id: Schema.NonEmptyString,
	secret: Schema.String.check(
		Schema.isPattern(/^tskey-client-\S+$/, { expected: "an OAuth client secret, tskey-client-…" }),
	),
});

export interface OAuthClient extends Schema.Schema.Type<typeof OAuthClient> {}

/** A device on the tailnet. */
export interface Device {
	/** The node id, which the API removes it by. */
	readonly node: string;
	/** Its MagicDNS name, <name>.<tailnet>.ts.net. */
	readonly name: string;
	/** The hostname it reported, which aett makes its machine's name. */
	readonly hostname: string;
	readonly address: string;
	readonly tags: ReadonlyArray<string>;
	readonly created: Date;
}

/** A one-time auth key and when it stops working. */
export interface AuthKey {
	readonly key: Redacted.Redacted;
	readonly expires: Date;
}

const Token = Schema.Struct({
	access_token: Schema.String,
	scope: Schema.optionalKey(Schema.String),
});

// What a failed call says, with the API's own message where it gave one.
const failure = (doing: string) => (cause: { readonly message: string }) =>
	new TailscaleError({ message: `Could not ${doing} through Tailscale's API: ${cause.message}` });

/** The scopes aett's OAuth client needs: minting keys, and finding and removing devices. */
export const scopes = ["auth_keys", "devices:core"] as const;

const Key = Schema.Struct({ key: Schema.String, expires: Schema.String });

const Devices = Schema.Struct({
	devices: Schema.Array(
		Schema.Struct({
			nodeId: Schema.String,
			name: Schema.String,
			hostname: Schema.String,
			addresses: Schema.Array(Schema.String),
			tags: Schema.optionalKey(Schema.Array(Schema.String)),
			created: Schema.String,
		}),
	),
});

/**
 * Tailscale's API, as the fleet's OAuth client: it mints a one-time tagged
 * key per machine, finds the machines on the tailnet and removes them. The
 * tailnet's policy stays its owner's.
 */
export class Tailscale extends Context.Service<
	Tailscale,
	{
		/** Checks that `client` signs in with the scopes aett needs, before aett keeps it. */
		readonly check: (client: OAuthClient) => Effect.Effect<void, TailscaleError>;
		/** A preauthorized, non-reusable key for one machine with `tags`, valid for a day. */
		readonly mintKey: (
			client: OAuthClient,
			tags: ReadonlyArray<string>,
		) => Effect.Effect<AuthKey, TailscaleError>;
		readonly devices: (client: OAuthClient) => Effect.Effect<ReadonlyArray<Device>, TailscaleError>;
		readonly removeDevice: (
			client: OAuthClient,
			node: string,
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
						Effect.mapError(failure("sign in with the OAuth client")),
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

			const mintKey = Effect.fn("Tailscale.mintKey")(function* (
				client: OAuthClient,
				tags: ReadonlyArray<string>,
			) {
				const api = yield* authorized(client);

				const minted = yield* HttpClientRequest.post("/tailnet/-/keys").pipe(
					HttpClientRequest.bodyJson({
						capabilities: {
							devices: {
								create: { reusable: false, ephemeral: false, preauthorized: true, tags },
							},
						},
						expirySeconds: 86_400,
						description: "aett",
					}),
					Effect.flatMap(api.execute),
					Effect.flatMap(HttpClientResponse.schemaBodyJson(Key)),
					Effect.mapError(failure(`mint a key for ${tags.join(", ")}`)),
				);

				return {
					key: Redacted.make(minted.key),
					expires: new Date(minted.expires),
				} satisfies AuthKey;
			});

			const devices = Effect.fn("Tailscale.devices")(function* (client: OAuthClient) {
				const api = yield* authorized(client);

				const listed = yield* api
					.get("/tailnet/-/devices")
					.pipe(
						Effect.flatMap(HttpClientResponse.schemaBodyJson(Devices)),
						Effect.mapError(failure("list the tailnet's devices")),
					);

				return listed.devices.flatMap((device) => {
					const address = device.addresses.find((candidate) => isIP(candidate) === 4);

					return address === undefined
						? []
						: [
								{
									node: device.nodeId,
									name: device.name.replace(/\.$/, ""),
									hostname: device.hostname,
									address,
									tags: device.tags ?? [],
									created: new Date(device.created),
								} satisfies Device,
							];
				});
			});

			const removeDevice = Effect.fn("Tailscale.removeDevice")(function* (
				client: OAuthClient,
				node: string,
			) {
				const api = yield* authorized(client);

				yield* api
					.del(`/device/${encodeURIComponent(node)}`)
					.pipe(Effect.mapError(failure(`remove the device ${node}`)));
			});

			const check = Effect.fn("Tailscale.check")(function* (client: OAuthClient) {
				const granted = new Set((yield* token(client)).scope?.split(" ") ?? []);
				const missing = scopes.filter((scope) => !granted.has(scope));

				if (missing.length > 0) {
					return yield* new TailscaleError({
						message: `The OAuth client lacks the scope ${missing.join(" and ")}. Make one with Auth Keys: Write and Devices Core: Write.`,
					});
				}

				return yield* Effect.void;
			});

			return Tailscale.of({ check, mintKey, devices, removeDevice });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}

/**
 * The device a machine became when it joined with a key aett minted at
 * `since`: the newest one with its hostname and `tag` that joined after.
 */
export const joinedAs = (
	devices: ReadonlyArray<Device>,
	hostname: string,
	tag: string,
	since: Date,
) =>
	devices
		.filter(
			(device) =>
				device.hostname === hostname &&
				device.tags.includes(tag) &&
				device.created.getTime() >= since.getTime() - 60_000,
		)
		.toSorted((a, b) => b.created.getTime() - a.created.getTime())[0];
