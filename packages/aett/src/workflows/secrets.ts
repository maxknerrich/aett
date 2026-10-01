import { Console, Effect, FileSystem, Option, Path, Redacted } from "effect";
import { Prompt } from "effect/cli";
import { Secrets, SecretsError } from "../adapters/secrets.ts";
import type { Fleet } from "../domain/fleet.ts";
import { type MachineSecret, machineSecrets } from "../domain/secrets.ts";
import type { State } from "../domain/state.ts";
import { machineAgeKeys } from "./identity.ts";
import { loadFleet, readState } from "./load.ts";

// Where a machine secret lives in the fleet.
const secretFile = (secret: MachineSecret) => `secrets/${secret.name}.json`;

// Who a machine secret is encrypted to: the operators, and every declared machine that reads it and has a host key.
const recipientsOf = Effect.fn("recipientsOf")(function* (
	root: string,
	fleet: Fleet,
	state: State,
	secret: MachineSecret,
) {
	const readers = fleet.machines.filter(secret.readBy).map(({ name }) => name);

	return [...state.operator.ageKeys, ...(yield* machineAgeKeys(root, readers))];
});

/**
 * Encrypts each machine secret the fleet has to the operators and the
 * machines that read it now, decrypting it only when they changed. Returns
 * the names of the secrets that exist.
 */
export const shareSecrets = Effect.fn("shareSecrets")(function* (
	root: string,
	fleet: Fleet,
	state: State,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const secrets = yield* Secrets;

	const present = yield* Effect.filter(machineSecrets(fleet), (secret) =>
		fs.exists(path.join(root, secretFile(secret))),
	);

	yield* Effect.forEach(present, (secret) =>
		recipientsOf(root, fleet, state, secret).pipe(
			Effect.flatMap((recipients) => secrets.share(root, secretFile(secret), recipients)),
			Effect.flatMap((changed) =>
				changed
					? Console.log(`Encrypted ${secretFile(secret)} to the machines that read it now.`)
					: Effect.void,
			),
		),
	);

	return present.map(({ name }) => name);
});

/** Asks for a machine secret and stores it, encrypted to the operators and the machines that read it. */
export const setSecret = Effect.fn("setSecret")(function* (root: string, name: string) {
	const secrets = yield* Secrets;
	const fleet = yield* loadFleet(root);
	const known = machineSecrets(fleet);
	const secret = known.find((candidate) => candidate.name === name);

	if (secret === undefined) {
		return yield* new SecretsError({
			message: `aett knows no secret named ${name}. It knows ${known.map((candidate) => candidate.name).join(", ")}.`,
		});
	}

	const value = yield* Prompt.Password({
		message: secret.prompt,
		validate: (input) =>
			Option.match(secret.invalid(input), {
				onNone: () => Effect.succeed(input),
				onSome: Effect.fail,
			}),
	});

	const recipients = yield* recipientsOf(root, fleet, yield* readState(root, fleet), secret);

	yield* secrets.write(root, secretFile(secret), recipients, Redacted.value(value));

	return yield* Console.log(`Machines that read it get it with their next apply.`);
});
