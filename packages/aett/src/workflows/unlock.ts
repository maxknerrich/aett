import { Console, Effect, Path, Schema } from "effect";
import { Secrets } from "../adapters/secrets.ts";
import { Ssh } from "../adapters/ssh.ts";
import { loadFleet, readState } from "./load.ts";

export class UnlockError extends Schema.TaggedError<UnlockError>()("UnlockError", {
	message: Schema.String,
}) {}

/** The name aett knows an encrypted machine's initrd by, on the tailnet and in its known hosts. */
export const unlockName = (machine: string) => `${machine}-unlock`;

/**
 * Opens an encrypted machine that waits at boot for its disk passphrase: logs
 * in to its initrd over the tailnet and answers the prompt with the
 * passphrase the fleet keeps. The machine then boots.
 */
export const unlock = Effect.fn("unlock")(function* (root: string, name: string) {
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

	if (recorded === undefined) {
		return yield* new UnlockError({
			message: `${name}'s initrd isn't on the tailnet yet. It joins with the first apply after install; until then, type the passphrase at ${name}'s console.`,
		});
	}

	const passphrase = yield* secrets.read(root, path.join("secrets", name, "luks-passphrase.json"));

	yield* Console.log(`Connecting to ${name}'s initrd at ${recorded.tailnetName}…`);

	const connection = yield* ssh.machine(
		unlockName(name),
		{ name: recorded.tailnet, port: 22 },
		path.join(root, "state", "known_hosts"),
		"refuse",
	);

	// The initrd runs aett-unlock for the operators' keys whatever they ask for.
	const answer = yield* connection.run("aett-unlock", `${passphrase}\n`);

	return yield* Console.log(answer.trim());
}, Effect.scoped);
