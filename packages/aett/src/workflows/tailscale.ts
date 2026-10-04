import { Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Secrets } from "../adapters/secrets.ts";
import { OAuthClient, Tailscale, TailscaleError } from "../adapters/tailscale.ts";
import type { Fleet } from "../domain/fleet.ts";
import { secretFile } from "../domain/secrets.ts";
import { mergePolicy, policyNeeds, policySnippet } from "../domain/tailnet.ts";
import { FleetError, loadFleet, readState } from "./load.ts";

/** Where the fleet keeps the OAuth client that edits the tailnet's policy, encrypted to the operators alone. */
const clientFile = secretFile("tailscale/oauth");

const ClientJson = Schema.fromJsonString(OAuthClient);

/** The fleet's OAuth client, or none before aett tailscale setup. */
export const oauthClient = Effect.fn("oauthClient")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	if (!(yield* fs.exists(path.join(root, clientFile)))) return Option.none<OAuthClient>();

	return Option.some(
		yield* (yield* Secrets).read(root, clientFile).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(ClientJson)),
			Effect.catchTag("SchemaError", () =>
				Effect.fail(new FleetError({ message: `${clientFile} holds no OAuth client.` })),
			),
		),
	);
});

const policyPage = "https://login.tailscale.com/admin/acls/file";

// Where aett notes what it last showed an operator who keeps the policy by hand.
const shownFile = "state/policy.json";

/**
 * Sets up the fleet's tailnet once: says how machines join, and keeps the
 * OAuth client that lets aett edit the tailnet's policy, if the operator
 * gives one. Without one it shows what to add to the policy by hand.
 */
export const setupTailscale = Effect.fn("setupTailscale")(function* (root: string) {
	const fleet = yield* loadFleet(root);
	const tailscale = yield* Tailscale;
	const secrets = yield* Secrets;
	const state = yield* readState(root, fleet);

	const web = [...fleet.services.values()].some(({ plugin }) =>
		Object.values(plugin.endpoints ?? {}).some((endpoint) => endpoint.web === true),
	);

	yield* Console.log(
		[
			"Each machine joins your tailnet once, when aett installs or first applies it: aett opens a",
			"login page in your browser and you approve the machine there. It joins tagged with its",
			"role, so the tailnet's policy has to list the fleet's tags, and grants let its machines",
			"reach each other's services.",
			"",
			"aett can add those to the policy itself with an OAuth client that has the scope",
			"Policy File: Write, which you generate under Settings → OAuth clients",
			"(https://login.tailscale.com/admin/settings/oauth). Without one, aett shows what to add.",
			...(web
				? [
						"",
						"Web endpoints get their certificates once MagicDNS and HTTPS Certificates are on under",
						"DNS (https://login.tailscale.com/admin/dns).",
					]
				: []),
			"",
		].join("\n"),
	);

	if (!(yield* Prompt.Confirm({ message: "Let aett edit the policy with an OAuth client?" }))) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const stored = path.join(root, clientFile);

		if (yield* fs.exists(stored)) {
			yield* fs.remove(stored);
			yield* Console.log(`Removed ${clientFile}: aett no longer edits the policy.`);
		}

		return yield* showPolicy(root, fleet);
	}

	const id = yield* Prompt.String({ message: "The OAuth client's ID" });

	const secret = yield* Prompt.Password({
		message: "Its secret (tskey-client-…)",
		validate: (value) =>
			/^tskey-client-\S+$/.test(value)
				? Effect.succeed(value)
				: Effect.fail("Expected a client secret such as tskey-client-…"),
	});

	const client: OAuthClient = { id: id.trim(), secret: Redacted.value(secret).trim() };

	yield* tailscale.check(client);
	yield* secrets.write(root, clientFile, state.operator.ageKeys, JSON.stringify(client));
	yield* Console.log("The OAuth client works.");

	return yield* syncPolicy(root, fleet);
});

/**
 * Makes sure the tailnet's policy lists what the fleet needs before its
 * machines join: aett adds what it lacks with the OAuth client, or else shows
 * the operator what to add whenever that changed since they last saw it.
 */
export const syncPolicy = Effect.fn("syncPolicy")(function* (root: string, fleet: Fleet) {
	const needs = policyNeeds(fleet);

	if (needs.tags.length === 0) return;

	const client = yield* oauthClient(root);

	if (Option.isNone(client)) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const file = path.join(root, shownFile);

		const shown =
			(yield* fs.exists(file)) && (yield* fs.readFileString(file)) === JSON.stringify(needs);

		if (!shown) yield* showPolicy(root, fleet);

		return;
	}

	const tailscale = yield* Tailscale;

	// Machines can still join once the operator adds what aett couldn't.
	yield* Effect.gen(function* () {
		const current = yield* tailscale.policy(client.value);

		const merged = yield* Effect.fromResult(mergePolicy(current.text, needs)).pipe(
			Effect.mapError((message) => new TailscaleError({ message })),
		);

		if (Option.isNone(merged)) return;

		yield* tailscale.setPolicy(client.value, merged.value, current.etag);
		yield* Console.log("Added the fleet's tags and grants to the tailnet's policy.");
	}).pipe(
		Effect.catchTag("TailscaleError", (error) =>
			Console.log(error.message).pipe(Effect.andThen(showPolicy(root, fleet))),
		),
	);
});

// Shows the operator what the policy needs and notes that they saw it.
const showPolicy = Effect.fn("showPolicy")(function* (root: string, fleet: Fleet) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const needs = policyNeeds(fleet);

	yield* Console.log(
		`The tailnet's policy (${policyPage}) needs these tags and grants for the fleet's machines to join and reach each other. Add what it lacks, or let aett do it with aett tailscale setup:\n\n${policySnippet(needs)}\n`,
	);
	yield* fs.writeFileString(path.join(root, shownFile), JSON.stringify(needs));
});

/**
 * How a joining machine is approved: aett opens the URL it waits at in the
 * operator's browser, or says to open it.
 */
export const approver = Effect.fn("approver")(function* (name: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	return (url: string) =>
		Effect.firstSuccessOf(
			["open", "xdg-open"].map((command) =>
				spawner
					.exitCode(ChildProcess.make(command, [url], { stdout: "ignore", stderr: "ignore" }))
					.pipe(Effect.filterOrFail((exitCode) => exitCode === 0)),
			),
		).pipe(
			Effect.as(`Approve ${name} on the tailnet in your browser (${url}). aett waits for it.`),
			Effect.orElseSucceed(
				() => `Open ${url} and approve ${name} on the tailnet there. aett waits for it.`,
			),
			Effect.flatMap(Console.log),
		);
});
