import { isIP } from "node:net";
import { Console, Effect, Option, Path, Schedule, Schema } from "effect";
import { type Connection, Ssh, SshError } from "../adapters/ssh.ts";
import type { Fleet } from "../domain/fleet.ts";
import type { State } from "../domain/state.ts";
import { updateRecord } from "./load.ts";
import { findOnTailnet } from "./tailscale.ts";

// Where state says a machine is on the tailnet, as an SSH endpoint.
const tailnetHost = (state: State, name: string) =>
	Option.map(Option.fromUndefinedOr(state.machines.get(name)?.tailnet), (address) => ({
		name: address,
		port: 22,
	}));

/**
 * Logs in to a bare-metal machine over the tailnet, aett's only way to it,
 * with aett's known hosts. A machine state has no address for yet is looked
 * up on the tailnet first; one that just booted gets a few minutes to join.
 */
export const connectMachine = Effect.fn("connectMachine")(function* (
	root: string,
	fleet: Fleet,
	state: State,
	name: string,
) {
	const ssh = yield* Ssh;
	const path = yield* Path.Path;
	const knownHosts = path.join(root, "state", "known_hosts");

	const address = yield* Option.match(tailnetHost(state, name), {
		onSome: ({ name: recorded }) => Effect.succeed(recorded),
		onNone: () =>
			Console.log(`Looking for ${name} on the tailnet…`).pipe(
				Effect.andThen(findOnTailnet(root, fleet, state, name)),
				Effect.flatMap((found) =>
					Effect.fromOption(
						found,
						() =>
							new SshError({
								message: `${name} isn't on the tailnet yet, and aett reaches machines only there.`,
							}),
					),
				),
				Effect.retry(Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "5 minutes" }))),
			),
	});

	yield* Console.log(`Connecting to ${name} at ${address}…`);

	return yield* ssh.machine(name, { name: address, port: 22 }, knownHosts);
});

/**
 * Logs in to a running guest over the tailnet once it joined, else through
 * `host`, the open connection to its host. A guest its host just started
 * needs a moment before sshd answers, so through its host aett keeps trying
 * for a minute and a half.
 */
export const connectGuest = Effect.fn("connectGuest")(function* (
	root: string,
	state: State,
	name: string,
	host: Connection,
) {
	const ssh = yield* Ssh;
	const path = yield* Path.Path;
	const knownHosts = path.join(root, "state", "known_hosts");
	const login = ssh.guest(name, state.machines.get(name)?.address ?? "", knownHosts, host);

	const throughHost = login.pipe(
		Effect.catchTag("SshError", () =>
			Console.log(`Waiting for ${name} to answer over SSH…`).pipe(
				Effect.andThen(
					login.pipe(
						Effect.retry(
							Schedule.spaced("2 seconds").pipe(Schedule.upTo({ duration: "90 seconds" })),
						),
					),
				),
			),
		),
	);

	return yield* Option.match(tailnetHost(state, name), {
		onNone: () => throughHost,
		onSome: (tailnet) =>
			ssh.machine(name, tailnet, knownHosts).pipe(Effect.catchTag("SshError", () => throughHost)),
	});
});

// What `tailscale status --json` says about the machine itself.
const SelfStatus = Schema.fromJsonString(
	Schema.Struct({
		Self: Schema.Struct({
			ID: Schema.String,
			DNSName: Schema.String,
			TailscaleIPs: Schema.Array(Schema.String),
		}),
	}),
);

/** Records the machine's address, name and node on the tailnet once Tailscale reports them and state lacks them. */
export const recordTailnet = Effect.fn("recordTailnet")(function* (
	root: string,
	state: State,
	name: string,
	connection: Connection,
) {
	const printed = yield* connection.run(
		"tailscale status --json --peers=false 2>/dev/null || true",
	);

	const status = yield* Schema.decodeUnknownEffect(SelfStatus)(printed).pipe(Effect.option);

	if (Option.isNone(status)) return;

	const { ID, DNSName, TailscaleIPs } = status.value.Self;
	const address = TailscaleIPs.find((ip) => isIP(ip) === 4);
	const recorded = state.machines.get(name);

	if (
		address === undefined ||
		DNSName === "" ||
		(recorded?.tailnet === address && recorded.node === ID)
	) {
		return;
	}

	yield* updateRecord(root, name, {
		tailnet: address,
		tailnetName: DNSName.replace(/\.$/, ""),
		node: ID,
	});
	yield* Console.log(`${name} is on the tailnet as ${DNSName.replace(/\.$/, "")} (${address}).`);
});
