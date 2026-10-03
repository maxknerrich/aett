import { Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { Prompt } from "effect/cli";
import { Secrets } from "../adapters/secrets.ts";
import { joinedAs, OAuthClient, Tailscale } from "../adapters/tailscale.ts";
import type { Fleet } from "../domain/fleet.ts";
import { grantsFor, ownerTag, tagOf, unlockTag } from "../domain/tailnet.ts";
import { secretFile, tailscaleKey } from "../domain/secrets.ts";
import type { State } from "../domain/state.ts";
import { machineAgeKeys } from "./identity.ts";
import { FleetError, loadFleet, readState, updateRecord } from "./load.ts";

/** Where the fleet keeps its Tailscale OAuth client, encrypted to the operators alone. */
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

/**
 * Sets up the fleet's tailnet access once: says what the tailnet's policy
 * needs and how to make the OAuth client, asks for it, checks it and keeps
 * it encrypted to the operators.
 */
export const setupTailscale = Effect.fn("setupTailscale")(function* (root: string) {
	const fleet = yield* loadFleet(root);
	const tailscale = yield* Tailscale;
	const secrets = yield* Secrets;
	const state = yield* readState(root, fleet);

	const grants = grantsFor(fleet, state);

	const web = [...fleet.services.values()].some(({ plugin }) =>
		Object.values(plugin.endpoints ?? {}).some((endpoint) => endpoint.web === true),
	);

	const tags = [
		...new Set([
			...fleet.machines.map(({ role }) => tagOf(role)),
			...(fleet.machines.some(({ encrypted }) => encrypted) ? [unlockTag] : []),
		]),
	].toSorted();

	yield* Console.log(
		[
			"aett reaches every machine over your tailnet. Each machine joins once with a key aett mints",
			"for it through an OAuth client, tagged with its role. Your policy stays yours.",
			"",
			"1. In the tailnet policy file (https://login.tailscale.com/admin/acls/file), add the tags, each",
			`   owned by ${ownerTag}, the OAuth client's own tag, so it can mint keys with any one of them:`,
			"",
			`   "tagOwners": { "${ownerTag}": ["autogroup:admin"], ${tags.map((tag) => `"${tag}": ["autogroup:admin", "${ownerTag}"]`).join(", ")} },`,
			"",
			"   and let this computer reach them on port 22. Give tag:unlock no access of its own: an",
			"   encrypted machine's initrd joins with it, and its key sits unencrypted on the boot disk.",
			...(grants.length === 0
				? []
				: [
						"",
						"   The fleet's machines reach each other's services through these grants:",
						"",
						...grants.map((grant) => `   ${JSON.stringify(grant)},`),
					]),
			"",
			"2. Under Settings → OAuth clients (https://login.tailscale.com/admin/settings/oauth),",
			"   generate a client with these scopes:",
			"",
			`   Auth Keys: Write, with the tag ${ownerTag}`,
			`   Devices Core: Write, with the tag ${ownerTag}`,
			"",
			...(web
				? [
						"3. Under DNS (https://login.tailscale.com/admin/dns), turn on MagicDNS and HTTPS",
						"   Certificates: the fleet's web endpoints get their certificates there.",
						"",
					]
				: []),
		].join("\n"),
	);

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

	return yield* Console.log(
		"The OAuth client works. Machines join the tailnet with their next install or apply.",
	);
});

/**
 * Mints a one-time key for each machine in `machines` that isn't on the
 * tailnet yet and has no key that still works, and keeps it encrypted to the
 * operators and the machine. Without the OAuth client it says how to set it
 * up instead. A Mac that runs the Tailscale app joins by itself.
 */
export const mintKeys = Effect.fn("mintKeys")(function* (
	root: string,
	fleet: Fleet,
	state: State,
	machines: ReadonlySet<string>,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const secrets = yield* Secrets;
	const tailscale = yield* Tailscale;
	const now = Date.now();

	// A machine already on the tailnet, or holding a key that still works, needs none.
	const joining = yield* Effect.filter(
		fleet.machines.filter(({ name }) => {
			const recorded = state.machines.get(name);

			return (
				machines.has(name) &&
				recorded?.tailnet === undefined &&
				recorded?.node === undefined &&
				recorded?.tailscaleApp !== true
			);
		}),
		({ name }) =>
			Effect.map(fs.exists(path.join(root, secretFile(tailscaleKey(name)))), (exists) => {
				const expires = state.machines.get(name)?.tailscaleKeyExpires;

				return !exists || expires === undefined || Date.parse(expires) < now;
			}),
	);

	if (joining.length === 0) return yield* Effect.void;

	const client = yield* oauthClient(root);

	if (Option.isNone(client)) {
		return yield* Console.log(
			`${joining.map(({ name }) => name).join(", ")} can't join the tailnet until you run aett tailscale setup.`,
		);
	}

	return yield* Effect.forEach(
		joining,
		(machine) =>
			Effect.gen(function* () {
				const { key, expires } = yield* tailscale.mintKey(client.value, [tagOf(machine.role)]);
				const recipients = yield* machineAgeKeys(root, state, [machine.name]);

				yield* secrets.write(
					root,
					secretFile(tailscaleKey(machine.name)),
					[...state.operator.ageKeys, ...recipients],
					Redacted.value(key),
				);
				// The key's tag is the node's once it joins, whatever role the machine has by then.
				yield* updateRecord(root, machine.name, {
					tailscaleKeyExpires: expires.toISOString(),
					tag: tagOf(machine.role),
				});
				yield* Console.log(`Minted ${machine.name}'s key to join the tailnet.`);
			}),
		{ discard: true },
	);
});

/**
 * Records what state lacks about each of `machines` on the tailnet, as the
 * tailnet lists them: the name and node of one known by its address, and
 * all of it for one that joined with the key aett minted for it. A node
 * whose tag isn't its machine's role's, after a role changed, gets that tag.
 * Plugins then name their peers, and no machine gets a key it doesn't need.
 * Without the OAuth client it waits.
 */
export const nameOnTailnet = Effect.fn("nameOnTailnet")(function* (
	root: string,
	fleet: Fleet,
	state: State,
	machines: ReadonlySet<string>,
) {
	const ours = fleet.machines.filter(
		({ name }) => machines.has(name) && state.machines.get(name)?.tailscaleApp !== true,
	);

	const unsettled = ours.filter(({ name, role }) => {
		const recorded = state.machines.get(name);

		return recorded?.tailnet === undefined
			? recorded?.tailscaleKeyExpires !== undefined
			: recorded.tailnetName === undefined ||
					recorded.node === undefined ||
					recorded.tag !== tagOf(role);
	});

	if (unsettled.length === 0) return;

	const client = yield* oauthClient(root);

	if (Option.isNone(client)) return;

	const tailscale = yield* Tailscale;
	const devices = yield* tailscale.devices(client.value);

	yield* Effect.forEach(unsettled, ({ name, role }) => {
		const recorded = state.machines.get(name);

		// One known only by its key joined after aett minted it; keys are good for a day.
		const device = Option.fromUndefinedOr(
			recorded?.tailnet === undefined
				? joinedAs(
						devices,
						name,
						recorded?.tag ?? tagOf(role),
						new Date(Date.parse(recorded?.tailscaleKeyExpires ?? "") - 86_400_000),
					)
				: devices.find(({ address }) => address === recorded.tailnet),
		);

		return Effect.forEach(Option.toArray(device), (found) =>
			Effect.gen(function* () {
				if (!(found.tags.length === 1 && found.tags[0] === tagOf(role))) {
					yield* tailscale.setTags(client.value, found.node, [tagOf(role)]);
					yield* Console.log(`Tagged ${name} ${tagOf(role)} on the tailnet.`);
				}

				yield* updateRecord(root, name, {
					tailnet: found.address,
					tailnetName: found.name,
					node: found.node,
					tag: tagOf(role),
				});
			}),
		);
	});
});

/** A one-time key for an encrypted machine's initrd to join with as tag:unlock, if the OAuth client is set up. */
export const mintUnlockKey = Effect.fn("mintUnlockKey")(function* (root: string) {
	const tailscale = yield* Tailscale;
	const client = yield* oauthClient(root);

	return yield* Effect.transposeOption(
		Option.map(client, (found) =>
			Effect.map(tailscale.mintKey(found, [unlockTag]), ({ key }) => key),
		),
	);
});

/**
 * Looks up on the tailnet the machine that joined with the key aett minted
 * for it, and records its address, name and node. Returns its address.
 */
export const findOnTailnet = Effect.fn("findOnTailnet")(function* (
	root: string,
	fleet: Fleet,
	state: State,
	name: string,
) {
	const tailscale = yield* Tailscale;
	const client = yield* oauthClient(root);
	const machine = fleet.machines.find((declared) => declared.name === name);
	const expires = state.machines.get(name)?.tailscaleKeyExpires;

	if (Option.isNone(client) || machine === undefined || expires === undefined) {
		return Option.none<string>();
	}

	// Keys are good for a day; the machine joined after aett minted its key.
	const minted = new Date(Date.parse(expires) - 86_400_000);

	const device = joinedAs(
		yield* tailscale.devices(client.value),
		name,
		state.machines.get(name)?.tag ?? tagOf(machine.role),
		minted,
	);

	if (device === undefined) return Option.none<string>();

	yield* updateRecord(root, name, {
		tailnet: device.address,
		tailnetName: device.name,
		node: device.node,
	});

	yield* Console.log(`${name} is on the tailnet as ${device.name} (${device.address}).`);

	return Option.some(device.address);
});

/** Removes a machine's node, and its initrd's, from the tailnet, if the OAuth client is set up. */
export const removeFromTailnet = Effect.fn("removeFromTailnet")(function* (
	root: string,
	state: State,
	name: string,
) {
	const tailscale = yield* Tailscale;
	const client = yield* oauthClient(root);
	const recorded = state.machines.get(name);

	const nodes = [recorded?.node, recorded?.unlock?.node].flatMap((node) =>
		Option.toArray(Option.fromUndefinedOr(node)),
	);

	if (nodes.length === 0) return true;

	if (Option.isNone(client)) return false;

	yield* Effect.forEach(nodes, (node) => tailscale.removeDevice(client.value, node));

	return true;
});
