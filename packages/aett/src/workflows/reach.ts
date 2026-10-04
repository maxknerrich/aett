import { Console, Effect, Option, Path, Schedule } from "effect";
import { type Connection, Ssh, SshError } from "../adapters/ssh.ts";
import type { State } from "../domain/state.ts";
import { type Joined, joinedFrom } from "../domain/tailnet.ts";
import { updateRecord } from "./load.ts";

// Where state says a machine is on the tailnet, as an SSH endpoint.
const tailnetHost = (state: State, name: string) =>
	Option.map(Option.fromUndefinedOr(state.machines.get(name)?.tailnet), (address) => ({
		name: address,
		port: 22,
	}));

/**
 * Logs in to a bare-metal machine over the tailnet, aett's only way to it,
 * with aett's known hosts, where it joined at install. One that just booted
 * gets a few minutes to come up.
 */
export const connectMachine = Effect.fn("connectMachine")(function* (
	root: string,
	state: State,
	name: string,
) {
	const ssh = yield* Ssh;
	const path = yield* Path.Path;
	const knownHosts = path.join(root, "state", "known_hosts");

	const host = yield* Effect.fromOption(
		tailnetHost(state, name),
		() =>
			new SshError({
				message: `aett doesn't know where ${name} is on the tailnet, its only way to it. A machine joins when aett machine install installs it.`,
			}),
	);

	yield* Console.log(`Connecting to ${name} at ${host.name}…`);

	const login = ssh.machine(name, host, knownHosts);

	return yield* login.pipe(
		Effect.catchTag("SshError", () =>
			Console.log(`Waiting for ${name} to answer on the tailnet…`).pipe(
				Effect.andThen(
					login.pipe(
						Effect.retry(
							Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "5 minutes" })),
						),
					),
				),
			),
		),
	);
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

/** What the machine at `connection` says about itself on the tailnet, if it is on it. */
export const tailnetStatus = (connection: Connection) =>
	connection
		.run("tailscale status --json --peers=false 2>/dev/null || true")
		.pipe(Effect.map(joinedFrom));

/** Records where a machine is on the tailnet, as it says itself, when state lacks it. */
export const recordTailnet = Effect.fn("recordTailnet")(function* (
	root: string,
	state: State,
	name: string,
	joined: Joined,
) {
	const recorded = state.machines.get(name);

	if (recorded?.tailnet === joined.tailnet && recorded.tailnetName === joined.tailnetName) return;

	yield* updateRecord(root, name, { tailnet: joined.tailnet, tailnetName: joined.tailnetName });
	yield* Console.log(`${name} is on the tailnet as ${joined.tailnetName} (${joined.tailnet}).`);
});
