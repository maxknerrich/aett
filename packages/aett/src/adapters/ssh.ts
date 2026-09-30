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

/** SSH through the pinned OpenSSH from aett's tools, independent of the operator's SSH config and agent. */
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
	}
>()("aett/adapters/Ssh") {
	static readonly layer = Layer.effect(
		Ssh,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const nix = yield* Nix;

			const installer = Effect.fn("Ssh.installer")(function* (host: Host, code: Redacted.Redacted) {
				const bin = path.join(yield* nix.tools, "bin");
				const ssh = path.join(bin, "ssh");
				const destination = `root@${host.name}`;
				// Socket paths are limited to about 100 bytes, and the Mac's per-user temp directory is long.
				const directory = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "aett-" });
				const askpass = path.join(directory, "askpass");

				// Shared by the master, the commands that reuse it and nix, which splits NIX_SSHOPTS on spaces.
				// Without public keys, a command that misses the master can't offer the operator's agent keys.
				const options = [
					["-F", "none"],
					["-p", String(host.port)],
					["-o", `ControlPath=${path.join(directory, "control")}`],
					["-o", "PubkeyAuthentication=no"],
					["-o", "StrictHostKeyChecking=no"],
					["-o", "UserKnownHostsFile=/dev/null"],
					["-o", "LogLevel=ERROR"],
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

				// ssh reads the code from SSH_ASKPASS; the script hands it over from the master's environment.
				yield* fs.writeFileString(askpass, '#!/bin/sh\nprintf "%s\\n" "$AETT_CODE"\n', {
					mode: 0o700,
				});

				yield* Effect.acquireRelease(
					exec(
						[
							["-M", "-N", "-f"],
							["-o", "ControlPersist=yes"],
							["-o", "PreferredAuthentications=keyboard-interactive,password"],
							["-o", "NumberOfPasswordPrompts=1"],
							[destination],
						].flat(),
						{
							env: {
								SSH_ASKPASS: askpass,
								SSH_ASKPASS_REQUIRE: "force",
								AETT_CODE: Redacted.value(code),
							},
							extendEnv: true,
						},
					).pipe(
						Effect.filterOrFail(
							({ exitCode }) => exitCode === 0,
							({ stderr }) =>
								new SshError({
									message: `Could not log in to the installer at ${formatHost(host)}:\n${stderr}`,
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

				const inheritedPath = yield* Config.String("PATH").pipe(
					Config.withDefault(""),
					Effect.orDie,
				);

				return {
					// With more than one connection nix opens its own master, which has no code to log in with.
					store: `ssh-ng://${destination}?max-connections=1`,
					nixEnv: { PATH: `${bin}:${inheritedPath}`, NIX_SSHOPTS: options.join(" ") },
					run: remote("pipe"),
					stream: remote("inherit"),
				} satisfies Connection;
			});

			return Ssh.of({ installer });
		}),
	);
}
