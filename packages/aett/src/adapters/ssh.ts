import {
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	type PlatformError,
	Redacted,
	Schema,
	Scope,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { formatHost, type Host } from "../domain/host.ts";
import { Nix, type NixError } from "./nix.ts";

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
	message: Schema.String,
}) {}

/** An SSH connection to root on one host. Every command reuses its one master connection. */
export interface Connection {
	/** The host's Nix store as nix addresses it, an ssh-ng:// URL. */
	readonly store: string;
	/** Environment for nix commands that reach `store`: the pinned ssh first on PATH, NIX_SSHOPTS on the master connection. */
	readonly nixEnv: Readonly<Record<string, string>>;
	/** Runs a shell command on the host and returns its stdout. A failure carries the end of its stderr. */
	readonly run: (command: string) => Effect.Effect<string, SshError>;
	/** Runs a shell command like `run`, streaming its stderr to the terminal, for long commands such as builds. */
	readonly stream: (command: string) => Effect.Effect<string, SshError>;
}

/** Quotes an argument for a remote shell command. */
export const shellQuote = (value: string) =>
	/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** SSH through the pinned OpenSSH from aett's tools, independent of the operator's SSH config. */
export class Ssh extends Context.Service<
	Ssh,
	{
		/**
		 * Logs in to an installer as root with its code and keeps the connection
		 * open for the scope. Installers make a new host key on every boot, so the
		 * key is not checked.
		 */
		readonly installer: (
			host: Host,
			code: Redacted.Redacted,
		) => Effect.Effect<Connection, SshError | NixError | PlatformError.PlatformError, Scope.Scope>;
		/**
		 * Logs in to an installed machine as root with the operator's key from the
		 * SSH agent and keeps the connection open for the scope. The host key is
		 * checked against `knownHosts` under the machine's name, whatever its
		 * address, and recorded there on first contact.
		 */
		readonly machine: (
			name: string,
			host: Host,
			knownHosts: string,
		) => Effect.Effect<Connection, SshError | NixError | PlatformError.PlatformError, Scope.Scope>;
	}
>()("aett/adapters/Ssh") {
	static readonly layer = Layer.effect(
		Ssh,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const nix = yield* Nix;

			const inheritedPath = yield* Config.String("PATH").pipe(Config.withDefault(""), Effect.orDie);

			// Holds the control socket. Socket paths are limited to about 100 bytes, and the Mac's per-user temp directory is long.
			const temporaryDirectory = fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "aett-" });

			// Opens the master connection to root on `host` for the scope and returns the connection that reuses it.
			const open = Effect.fnUntraced(function* (host: Host, directory: string, login: Login) {
				const bin = path.join(yield* nix.tools, "bin");
				const ssh = path.join(bin, "ssh");
				const destination = `root@${host.name}`;

				// Shared by the master, the commands that reuse it and nix.
				const options = [
					["-F", "none"],
					["-p", String(host.port)],
					["-o", `ControlPath=${path.join(directory, "control")}`],
					["-o", "LogLevel=ERROR"],
					login.options.flatMap((option) => ["-o", option]),
				].flat();

				// Runs ssh to completion and returns its exit code with stdout and stderr, which stay empty unless piped.
				const exec = Effect.fnUntraced(
					function* (args: ReadonlyArray<string>, extra: ChildProcess.CommandOptions) {
						const handle = yield* spawner.spawn(
							ChildProcess.make(ssh, [...options, ...args], { stdin: "ignore", ...extra }),
						);

						const [stdout, stderr, exitCode] = yield* Effect.all(
							[
								Stream.mkString(Stream.decodeText(handle.stdout)),
								Stream.mkString(Stream.decodeText(handle.stderr)),
								handle.exitCode,
							],
							{ concurrency: "unbounded" },
						);

						return { stdout, stderr: stderr.trim(), exitCode };
					},
					Effect.scoped,
					Effect.mapError(
						(error) => new SshError({ message: `Could not run ssh: ${error.message}` }),
					),
				);

				yield* Effect.acquireRelease(
					exec(["-M", "-N", "-f", "-o", "ControlPersist=yes", destination], {
						env: login.env,
						extendEnv: true,
					}).pipe(
						Effect.filterOrFail(
							({ exitCode }) => exitCode === 0,
							({ stderr }) =>
								new SshError({
									message: `Could not log in to ${login.target} at ${formatHost(host)}:\n${stderr}`,
								}),
						),
					),
					() => Effect.ignore(exec(["-O", "exit", destination], {})),
				);

				// Runs a remote command; a failure shows the last lines of its stderr unless they streamed already.
				const remote = (stderr: "pipe" | "inherit") =>
					Effect.fn("Ssh.run")(function* (command: string) {
						const result = yield* exec([destination, command], { stderr });

						if (result.exitCode !== 0) {
							const tail = result.stderr.split("\n").slice(-20).join("\n");

							return yield* new SshError({
								message:
									`${command} failed on ${formatHost(host)} with exit code ${result.exitCode}.\n${tail}`.trim(),
							});
						}

						return result.stdout;
					});

				return {
					// With more than one connection nix opens its own master, which could not log in to an installer.
					store: `ssh-ng://${destination}?max-connections=1`,
					// nix splits NIX_SSHOPTS like a shell.
					nixEnv: {
						PATH: `${bin}:${inheritedPath}`,
						NIX_SSHOPTS: options.map(shellQuote).join(" "),
					},
					run: remote("pipe"),
					stream: remote("inherit"),
				} satisfies Connection;
			});

			const installer = Effect.fn("Ssh.installer")(function* (host: Host, code: Redacted.Redacted) {
				const directory = yield* temporaryDirectory;
				const askpass = path.join(directory, "askpass");

				// ssh reads the code from SSH_ASKPASS; the script hands it over from the master's environment.
				yield* fs.writeFileString(askpass, '#!/bin/sh\nprintf "%s\\n" "$AETT_CODE"\n', {
					mode: 0o700,
				});

				// The code alone logs in. Without public keys, a command that misses the master can't offer the operator's agent keys.
				return yield* open(host, directory, {
					target: "the installer",
					options: [
						"PubkeyAuthentication=no",
						"PreferredAuthentications=keyboard-interactive,password",
						"NumberOfPasswordPrompts=1",
						"StrictHostKeyChecking=no",
						"UserKnownHostsFile=/dev/null",
					],
					env: {
						SSH_ASKPASS: askpass,
						SSH_ASKPASS_REQUIRE: "force",
						AETT_CODE: Redacted.value(code),
					},
				});
			});

			const machine = Effect.fn("Ssh.machine")(function* (
				name: string,
				host: Host,
				knownHosts: string,
			) {
				return yield* open(host, yield* temporaryDirectory, {
					target: name,
					// Only the agent's keys, and only aett's known hosts, keyed by the machine's name.
					// ssh splits a known-hosts value on spaces unless it is quoted.
					options: [
						"BatchMode=yes",
						"PasswordAuthentication=no",
						"IdentityFile=none",
						`UserKnownHostsFile="${knownHosts}"`,
						"GlobalKnownHostsFile=/dev/null",
						`HostKeyAlias=${name}`,
						"StrictHostKeyChecking=accept-new",
						"CheckHostIP=no",
					],
					env: {},
				});
			});

			return Ssh.of({ installer, machine });
		}),
	);
}

// How aett logs in to one kind of host.
interface Login {
	/** Names the host in errors, such as "the installer". */
	readonly target: string;
	/** ssh -o options for authentication and host keys, shared by every command and nix. */
	readonly options: ReadonlyArray<string>;
	/** Environment for the master connection alone, which is the only one that authenticates. */
	readonly env: Readonly<Record<string, string>>;
}
