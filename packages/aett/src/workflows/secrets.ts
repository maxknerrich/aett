import { X509Certificate, randomBytes } from "node:crypto";
import { Console, Effect, FileSystem, Match, Option, Path, Redacted, Schema, Stream } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Secrets, SecretsError } from "../adapters/secrets.ts";
import { type Fleet, UserName } from "../domain/fleet.ts";
import { type MachineSecret, machineSecrets } from "../domain/secrets.ts";
import { buildable } from "../domain/build.ts";
import type { State } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";
import { knownHostKeys, machineAgeKeys } from "./identity.ts";
import { loadFleet, readState } from "./load.ts";

// Who a machine secret is encrypted to: the operators, and every machine that reads it and has an age key.
const recipientsOf = Effect.fn("recipientsOf")(function* (
	root: string,
	state: State,
	secret: MachineSecret,
) {
	return [...state.operator.ageKeys, ...(yield* machineAgeKeys(root, state, secret.readers))];
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

// A self-signed TLS certificate with its key, as one PEM file, made with the pinned openssl. Peers
// pin its fingerprint, so its name and lifetime don't matter.
const makeCertificate = Effect.fn("makeCertificate")(function* (name: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const openssl = path.join(yield* (yield* Engine).tools, "openssl");
	const directory = yield* fs.makeTempDirectoryScoped({ prefix: "aett-" });
	const key = path.join(directory, "key.pem");
	const certificate = path.join(directory, "certificate.pem");

	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(
			openssl,
			[
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-noenc",
				"-sha256",
				"-days",
				"36500",
				"-batch",
				"-subj",
				// Slashes separate the subject's fields.
				`/CN=${name.replaceAll("/", "-")}`,
				"-keyout",
				key,
				"-out",
				certificate,
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		),
	);

	if (exitCode !== 0) {
		return yield* new SecretsError({
			message: `openssl could not make a certificate for ${name}.`,
		});
	}

	return `${yield* fs.readFileString(certificate)}${yield* fs.readFileString(key)}`;
}, Effect.scoped);

/** The SHA-256 fingerprint of the certificate in a PEM file, as lowercase hex without colons. */
export const fingerprintOf = (pem: string) =>
	new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();

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

// Makes a secret aett generates, or asks for one it can't, and stores it encrypted to the operators
// and the machines that read it. A certificate's public half goes next to the machine's state too.
const store = Effect.fn("store")(function* (root: string, state: State, secret: MachineSecret) {
	const secrets = yield* Secrets;

	const value = yield* Match.value(secret.kind).pipe(
		Match.when("random", () => Effect.succeed(randomBytes(32).toString("hex"))),
		Match.when("certificate", () => makeCertificate(secret.name)),
		Match.orElse(() => ask(secret)),
	);

	yield* secrets.write(root, secret.file, yield* recipientsOf(root, state, secret), value);
	yield* keepCertificate(root, secret, value);
});

// Keeps the public half of a certificate secret where peers' fingerprints are read from.
const keepCertificate = Effect.fn("keepCertificate")(function* (
	root: string,
	secret: MachineSecret,
	pem: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* Effect.forEach(Option.toArray(secret.certificate), (file) =>
		fs
			.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
			.pipe(
				Effect.andThen(
					fs.writeFileString(
						path.join(root, file),
						pem.slice(0, pem.indexOf("-----END CERTIFICATE-----") + 26),
					),
				),
			),
	);
});

// The secrets a build that covers `included` needs: those some included machine reads.
const wantedBy = (fleet: Fleet, included: ReadonlySet<string>) =>
	machineSecrets(fleet).filter((secret) => secret.readers.some((reader) => included.has(reader)));

/**
 * Brings the machine secrets up to date for a build: makes or asks for each
 * required one that a machine the build covers reads and the fleet lacks, says
 * which optional ones are missing, and encrypts each one the fleet has to the
 * operators and the machines that read it now, decrypting it only when they
 * changed. Returns the names of the secrets that exist and the fingerprint of
 * each certificate by secret.
 */
export const shareSecrets = Effect.fn("shareSecrets")(function* (
	root: string,
	fleet: Fleet,
	state: State,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const secrets = yield* Secrets;
	const exists = (secret: MachineSecret) => fs.exists(path.join(root, secret.file));

	const missing = yield* Effect.filter(wantedBy(fleet, buildable(fleet, state)), (secret) =>
		Effect.map(exists(secret), (found) => !found),
	);

	yield* Effect.forEach(missing, (secret) =>
		secret.required
			? store(root, state, secret)
			: secret.kind === "tailscale"
				? Effect.void
				: Console.log(
						`${secret.file} is missing, so machines go without it until you run aett secret set ${secret.name}.`,
					),
	);

	const present = yield* Effect.filter(machineSecrets(fleet), exists);

	// A certificate whose public half went missing, say with a destroyed machine's state, has it again.
	yield* Effect.forEach(present, (secret) =>
		Effect.forEach(Option.toArray(secret.certificate), (file) =>
			Effect.gen(function* () {
				if (yield* fs.exists(path.join(root, file))) return;

				yield* keepCertificate(root, secret, yield* secrets.read(root, secret.file));
			}),
		),
	);

	yield* Effect.forEach(present, (secret) =>
		recipientsOf(root, state, secret).pipe(
			Effect.flatMap((recipients) => secrets.share(root, secret.file, recipients)),
			Effect.flatMap((changed) =>
				changed
					? Console.log(`Encrypted ${secret.file} to the machines that read it now.`)
					: Effect.void,
			),
		),
	);

	return {
		secrets: present.map(({ name }) => name),
		fingerprints: yield* fingerprints(root, fleet),
	};
});

/** The names of the machine secrets the fleet has, as they are, and each certificate's fingerprint. */
export const existingSecrets = Effect.fn("existingSecrets")(function* (root: string, fleet: Fleet) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const present = yield* Effect.filter(machineSecrets(fleet), (secret) =>
		fs.exists(path.join(root, secret.file)),
	);

	return {
		secrets: present.map(({ name }) => name),
		fingerprints: yield* fingerprints(root, fleet),
	};
});

// The fingerprint of every certificate whose public half the fleet keeps, by secret name.
const fingerprints = Effect.fn("fingerprints")(function* (root: string, fleet: Fleet) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const found = yield* Effect.forEach(machineSecrets(fleet), (secret) =>
		Option.match(secret.certificate, {
			onNone: () => Effect.succeed([]),
			onSome: (file) =>
				Effect.gen(function* () {
					const full = path.join(root, file);

					return (yield* fs.exists(full))
						? [[secret.name, fingerprintOf(yield* fs.readFileString(full))] as const]
						: [];
				}),
		}),
	);

	return new Map(found.flat());
});

/**
 * The machine secrets apply would change before it builds, each with why: a
 * required one the fleet lacks, or one whose machines changed since it was
 * encrypted, such as a guest that gets its host key from apply. One aett
 * can't check says why too. It reads them without changing any.
 */
export const pendingSecrets = Effect.fn("pendingSecrets")(function* (
	root: string,
	fleet: Fleet,
	state: State,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const secrets = yield* Secrets;

	const pending = yield* Effect.forEach(machineSecrets(fleet), (secret) =>
		Effect.gen(function* () {
			const { file } = secret;

			if (!(yield* fs.exists(path.join(root, file)))) {
				return secret.required ? [{ secret, reason: "isn't set yet" }] : [];
			}

			const had = yield* secrets.recipients(root, file);
			const wanted = new Set(yield* recipientsOf(root, state, secret));
			const known = yield* knownHostKeys(root);

			// A guest gets its host key from apply, which then encrypts the secrets it reads to it.
			const keyless = fleet.machines.some(
				(machine) =>
					Option.isSome(machine.vm) &&
					!known.has(machine.name) &&
					secret.readers.includes(machine.name),
			);

			const shared =
				!keyless &&
				had.size === wanted.size &&
				[...wanted].every((recipient) => had.has(recipient));

			return shared ? [] : [{ secret, reason: "isn't encrypted to the machines that read it yet" }];
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed([{ secret, reason: `can't be checked (${error.message})` }]),
			),
		),
	);

	return pending.flat();
});

/**
 * Asks for a machine secret and stores it encrypted to the operators and the
 * machines that read it. Only secrets someone types can be set; the ones aett
 * makes, such as a repository's password, stay as they are, since the data
 * they protect depends on them.
 */
export const setSecret = Effect.fn("setSecret")(function* (root: string, name: string) {
	const fleet = yield* loadFleet(root);
	const all = machineSecrets(fleet);
	const typed = all.filter(({ kind }) => kind === "password" || kind === "token");
	const secret = all.find((candidate) => candidate.name === name);

	if (secret === undefined) {
		// A user's password exists once fleet.ts names the user.
		const user = name.slice("users/".length);

		const hint =
			name.startsWith("users/") && Option.isNone(fleet.user) && Schema.is(UserName)(user)
				? ` ${name} is the password of the fleet's user, and fleet.ts names none: declare it with fleet({ user: "${user}", … }).`
				: "";

		return yield* new SecretsError({
			message: `aett knows no secret named ${name}. It knows ${typed.map((candidate) => candidate.name).join(", ")}.${hint}`,
		});
	}

	if (!typed.includes(secret)) {
		return yield* new SecretsError({
			message: `aett makes ${name} itself, and what it protects depends on it, so it isn't set by hand.`,
		});
	}

	yield* store(root, yield* readState(root, fleet), secret);

	return yield* Console.log(`Machines that read it get it with their next apply.`);
});
