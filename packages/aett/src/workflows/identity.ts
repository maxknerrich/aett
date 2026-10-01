import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Secrets, SecretsError } from "../adapters/secrets.ts";
import type { Connection } from "../adapters/ssh.ts";
import { trustHost } from "../domain/host.ts";
import { SshPublicKey } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";

const isSshPublicKey = Schema.is(SshPublicKey);

/**
 * The machine's SSH host key pair. The private key is the secret
 * secrets/<name>/ssh_host_ed25519_key.json, made on the controller by the
 * pinned ssh-keygen once and reused from then on, so a reinstalled machine or
 * a recreated guest keeps its identity and aett's known_hosts entry stays
 * valid.
 */
export const machineHostKey = Effect.fn("machineHostKey")(function* (
	root: string,
	name: string,
	recipients: ReadonlyArray<string>,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const secrets = yield* Secrets;
	const keygen = path.join(yield* (yield* Engine).tools, "ssh-keygen");
	const file = path.join("secrets", name, "ssh_host_ed25519_key.json");

	// ssh-keygen reads and writes private keys only as files. This one lives until the scope closes.
	const keyFile = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "aett-" }), "key");

	const generate = spawner
		.exitCode(
			ChildProcess.make(
				keygen,
				["-q", "-t", "ed25519", "-N", "", "-C", `root@${name}`, "-f", keyFile],
				{ stdin: "ignore" },
			),
		)
		.pipe(
			Effect.filterOrFail(
				(exitCode) => exitCode === 0,
				() => new SecretsError({ message: `ssh-keygen could not make a host key for ${name}.` }),
			),
			Effect.andThen(fs.readFileString(keyFile)),
		);

	const privateKey = yield* secrets.ensure(root, file, recipients, generate);

	// The public key is derived rather than stored. ssh-keygen wants the private key in a file only its owner can read.
	yield* fs.writeFileString(keyFile, privateKey, { mode: 0o600 });

	const publicKey = (yield* spawner.string(
		ChildProcess.make(keygen, ["-y", "-f", keyFile], { stdin: "ignore" }),
	)).trim();

	if (!isSshPublicKey(publicKey)) {
		return yield* new SecretsError({ message: `${file} holds no SSH private key.` });
	}

	return { privateKey, publicKey };
}, Effect.scoped);

/** Records the machine's host key in aett's known_hosts, replacing whatever it held for the machine. */
export const trustHostKey = Effect.fn("trustHostKey")(function* (
	root: string,
	name: string,
	publicKey: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, "state", "known_hosts");
	const knownHosts = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";

	yield* fs.writeFileString(file, trustHost(knownHosts, name, publicKey));
});

/**
 * Makes or reads each guest's host key, has `host` share it into the guest
 * and trusts it in aett's known_hosts. Runs before the host switches, so a
 * guest that starts finds its identity.
 */
export const placeGuestKeys = Effect.fn("placeGuestKeys")(function* (
	root: string,
	host: Connection,
	guests: ReadonlyArray<string>,
	recipients: ReadonlyArray<string>,
) {
	const engine = yield* Engine;

	yield* Effect.forEach(guests, (guest) =>
		machineHostKey(root, guest, recipients).pipe(
			Effect.tap((hostKey) => engine.placeGuestKey(host, guest, hostKey)),
			Effect.flatMap((hostKey) => trustHostKey(root, guest, hostKey.publicKey)),
		),
	);
});
