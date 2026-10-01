import { Console, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Secrets, SecretsError } from "../adapters/secrets.ts";
import { type Fleet, UserName } from "../domain/fleet.ts";
import { type MachineSecret, machineSecrets } from "../domain/secrets.ts";
import { buildable } from "../domain/build.ts";
import type { State } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";
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

// Hashes a password the way NixOS reads hashedPasswordFile, with the pinned mkpasswd.
const hashPassword = Effect.fn("hashPassword")(function* (password: Redacted.Redacted) {
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const mkpasswd = path.join(yield* (yield* Engine).tools, "mkpasswd");

	const hash = (yield* spawner.string(
		ChildProcess.make(mkpasswd, ["--method=yescrypt", "--stdin"], {
			stdin: Stream.make(new TextEncoder().encode(Redacted.value(password))),
		}),
	)).trim();

	if (!hash.startsWith("$y$")) {
		return yield* new SecretsError({ message: "mkpasswd could not hash the password." });
	}

	return hash;
});

// Asks for a secret's value: a token once, a password twice until both match, stored as its hash.
const ask = (secret: MachineSecret) => {
	const prompt = (message: string) =>
		Prompt.Password({
			message,
			validate: (input) =>
				Option.match(secret.invalid(input), {
					onNone: () => Effect.succeed(input),
					onSome: Effect.fail,
				}),
		});

	if (secret.kind === "token") return Effect.map(prompt(secret.prompt), Redacted.value);

	return Effect.gen(function* () {
		const password = yield* prompt(secret.prompt);
		const repeated = yield* Prompt.Password({ message: "The same password again" });
		const matches = Redacted.value(repeated) === Redacted.value(password);

		if (!matches) yield* Console.log("The two entries differ. Choose the password again.");

		return { password, matches };
	}).pipe(
		Effect.repeat({ until: ({ matches }) => matches }),
		Effect.flatMap(({ password }) => hashPassword(password)),
	);
};

// Asks for a machine secret and stores it, encrypted to the operators and the machines that read it.
const store = Effect.fn("store")(function* (
	root: string,
	fleet: Fleet,
	state: State,
	secret: MachineSecret,
) {
	const secrets = yield* Secrets;
	const value = yield* ask(secret);

	yield* secrets.write(
		root,
		secretFile(secret),
		yield* recipientsOf(root, fleet, state, secret),
		value,
	);
});

/**
 * Brings the machine secrets up to date for a build: asks for a required one
 * that a machine the build covers reads and the fleet lacks, says which
 * optional ones are missing, and encrypts each one the fleet has to the
 * operators and the machines that read it now, none left included,
 * decrypting it only when they changed. Returns the names of the secrets that
 * exist.
 */
export const shareSecrets = Effect.fn("shareSecrets")(function* (
	root: string,
	fleet: Fleet,
	state: State,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const secrets = yield* Secrets;
	const included = buildable(fleet, state);

	const wanted = machineSecrets(fleet).filter((secret) =>
		fleet.machines.some((machine) => included.has(machine.name) && secret.readBy(machine)),
	);

	const missing = yield* Effect.filter(wanted, (secret) =>
		Effect.map(fs.exists(path.join(root, secretFile(secret))), (exists) => !exists),
	);

	yield* Effect.forEach(missing, (secret) =>
		secret.required
			? store(root, fleet, state, secret)
			: Console.log(
					`${secretFile(secret)} is missing, so machines go without it until you run aett secret set ${secret.name}.`,
				),
	);

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

/** The names of the machine secrets the fleet has, as they are. */
export const existingSecrets = Effect.fn("existingSecrets")(function* (root: string, fleet: Fleet) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const present = yield* Effect.filter(machineSecrets(fleet), (secret) =>
		fs.exists(path.join(root, secretFile(secret))),
	);

	return present.map(({ name }) => name);
});

/** Asks for a machine secret and stores it, encrypted to the operators and the machines that read it. */
export const setSecret = Effect.fn("setSecret")(function* (root: string, name: string) {
	const fleet = yield* loadFleet(root);
	const known = machineSecrets(fleet);
	const secret = known.find((candidate) => candidate.name === name);

	if (secret === undefined) {
		// A user's password exists once fleet.ts names the user.
		const user = name.slice("users/".length);

		const hint =
			name.startsWith("users/") && Option.isNone(fleet.user) && Schema.is(UserName)(user)
				? ` ${name} is the password of the fleet's user, and fleet.ts names none: declare it with fleet({ user: "${user}", … }).`
				: "";

		return yield* new SecretsError({
			message: `aett knows no secret named ${name}. It knows ${known.map((candidate) => candidate.name).join(", ")}.${hint}`,
		});
	}

	yield* store(root, fleet, yield* readState(root, fleet), secret);

	return yield* Console.log(`Machines that read it get it with their next apply.`);
});
