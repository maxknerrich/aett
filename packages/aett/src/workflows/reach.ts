import { Console, Effect, Option, Path, Schedule } from "effect";
import { type Connection, Ssh } from "../adapters/ssh.ts";
import { formatHost, type Host } from "../domain/host.ts";
import type { State } from "../domain/state.ts";
import { updateRecord } from "./load.ts";

// Where aett finds a machine on the tailnet: the address state recorded, if any.
const tailnetHost = (state: State, name: string) =>
	Option.map(Option.fromUndefinedOr(state.machines.get(name)?.tailnet), (address): Host => ({
		name: address,
		port: 22,
	}));

/**
 * Logs in to a bare-metal machine with aett's known hosts: at `given`, or
 * else at <name>.local first and its tailnet address second.
 */
export const connectMachine = Effect.fn("connectMachine")(function* (
	root: string,
	state: State,
	name: string,
	given: Option.Option<Host>,
) {
	const ssh = yield* Ssh;
	const path = yield* Path.Path;
	const knownHosts = path.join(root, "state", "known_hosts");

	const hosts = Option.match(given, {
		onSome: (host) => [host],
		onNone: () => [
			{ name: `${name}.local`, port: 22 },
			...Option.toArray(tailnetHost(state, name)),
		],
	});

	return yield* Effect.firstSuccessOf(
		hosts.map((host) =>
			Console.log(`Connecting to ${name} at ${formatHost(host)}…`).pipe(
				Effect.andThen(ssh.machine(name, host, knownHosts)),
			),
		),
	);
});

/**
 * Logs in to a running guest over the tailnet when state knows its address
 * there, else through `host`, the open connection to its host. A guest its
 * host just started needs a moment before sshd answers, so through its host
 * aett keeps trying for a minute and a half.
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

/** Records the machine's tailnet address in state once Tailscale reports one that state lacks. */
export const recordTailnet = Effect.fn("recordTailnet")(function* (
	root: string,
	state: State,
	name: string,
	connection: Connection,
) {
	const reported =
		(yield* connection.run("tailscale ip -4 2>/dev/null || true")).trim().split("\n")[0] ?? "";

	if (
		!/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(reported) ||
		state.machines.get(name)?.tailnet === reported
	) {
		return;
	}

	yield* updateRecord(root, name, { tailnet: reported });
	yield* Console.log(`${name} is on the tailnet at ${reported}.`);
});
