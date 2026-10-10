import { Console, Effect, Option, Path, Schedule, Schema } from "effect";
import { Secrets } from "../adapters/secrets.ts";
import { Ssh } from "../adapters/ssh.ts";
import { loadFleet, readState } from "./load.ts";

export class UnlockError extends Schema.TaggedError<UnlockError>()("UnlockError", {
	message: Schema.String,
}) {}

/** The name aett knows an encrypted machine's initrd by in its known hosts, which no machine can have. */
export const unlockName = (machine: string) => `${machine}.unlock`;

// Where unlock.nix's sshd listens in the initrd.
const unlockPort = 2222;

/**
 * Opens an encrypted machine that waits at boot for its disk passphrase: logs
 * in to its initrd on its LAN, at the address install recorded or at `host`,
 * and answers the prompt with the passphrase the fleet keeps. The machine
 * then boots.
 */
export const unlock = Effect.fn("unlock")(function* (
	root: string,
	name: string,
	host: Option.Option<string>,
) {
	const path = yield* Path.Path;
	const ssh = yield* Ssh;
	const secrets = yield* Secrets;
	const fleet = yield* loadFleet(root);
	const machine = fleet.machines.find((declared) => declared.name === name);

	if (machine === undefined) {
		return yield* new UnlockError({ message: `fleet.ts declares no machine named "${name}".` });
	}

	if (!machine.encrypted || machine.kind !== "nixos") {
		return yield* new UnlockError({
			message: `${name} has no encrypted disk to open: only bare-metal NixOS machines declared encrypted, and NASes, have one.`,
		});
	}

	const recorded = (yield* readState(root, fleet)).machines.get(name)?.unlock;

	const address = yield* Effect.fromOption(
		Option.orElse(host, () => Option.fromUndefinedOr(recorded?.address)),
		() =>
			new UnlockError({
				message: `${name}'s initrd answers on its LAN once aett machine install set it up, and this install didn't. Type the passphrase at ${name}'s console.`,
			}),
	);

	const passphrase = yield* secrets.read(root, path.join("secrets", name, "luks-passphrase.json"));

	yield* Console.log(`Connecting to ${name}'s initrd at ${address}…`);

	const connection = yield* ssh
		.machine(
			unlockName(name),
			{ name: address, port: unlockPort },
			path.join(root, "state", "known_hosts"),
			"refuse",
		)
		.pipe(
			Effect.mapError(
				(error) =>
					new UnlockError({
						message: `${error.message}\n${name}'s initrd answers on its LAN, at ${address}:${unlockPort}. From another network, reach that LAN first, such as over your VPN, or pass --host with an address that reaches it.`,
					}),
			),
		);

	// The initrd runs aett-unlock for the operators' keys whatever they ask for. Opening the disk ends
	// the initrd and its sshd, often before aett-unlock reports, and the session drops with ssh's 255.
	const answer = yield* connection.run("aett-unlock", `${passphrase}\n`).pipe(
		Effect.catchIf(
			(error) => error.exitCode === 255,
			() => booted(root, name, address),
		),
	);

	return yield* Console.log(answer.trim());
}, Effect.scoped);

// Waits for the machine to answer on its own SSH at `address`, as it does once its disk opened and
// it booted.
const booted = Effect.fn("booted")(function* (root: string, name: string, address: string) {
	const path = yield* Path.Path;
	const ssh = yield* Ssh;

	yield* Console.log(`${name}'s initrd closed the connection. Waiting for ${name} to boot…`);

	yield* ssh
		.machine(name, { name: address, port: 22 }, path.join(root, "state", "known_hosts"), "refuse")
		.pipe(
			Effect.retry(Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: "3 minutes" }))),
			Effect.mapError(
				() =>
					new UnlockError({
						message: `The connection to ${name}'s initrd dropped after the passphrase, and ${name} hasn't answered at ${address} since. Its console shows what happened.`,
					}),
			),
		);

	return `Unlocked. ${name} is up.`;
}, Effect.scoped);
