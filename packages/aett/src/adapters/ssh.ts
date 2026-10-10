import {
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
import { formatHost, type Host, sshConfigPath } from "../domain/host.ts";
import { Engine, type EngineError } from "../engine/engine.ts";

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
	message: Schema.String,
	// A remote command's exit code, or ssh's own 255 when the connection failed or dropped.
	exitCode: Schema.optionalKey(Schema.Number),
}) {}

/** An SSH connection to root on one host. Every command reuses its one master connection. */
export interface Connection {
	/** Where ssh logs in: root@<host>. */
	readonly destination: string;
	/** The pinned ssh's options that reach the host through the master connection, for other programs that run ssh. */
	readonly sshOptions: ReadonlyArray<string>;
	/**
	 * Runs a shell command on the host and returns its stdout. `input`, if
	 * given, is the command's stdin. A failure carries the end of its stderr.
	 */
	readonly run: (command: string, input?: string) => Effect.Effect<string, SshError>;
	/** Runs a shell command like `run`, streaming its stderr to the terminal, for long commands such as builds. */
	readonly stream: (command: string) => Effect.Effect<string, SshError>;
	/** Set on the Mac aett runs on, where commands run as the operator, not as root over SSH. */
	readonly local?: boolean;
}

/** Quotes an argument for a remote shell command. */
export const shellQuote = (value: string) =>
	/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** What aett does with a machine's host key that its known hosts lack: records it, or refuses the machine. */
export type UnknownKey = "record" | "refuse";

// How aett logs in to a machine: only the agent's keys, and only aett's known hosts, keyed by the machine's name.
const machineOptions = (name: string, knownHosts: string, unknownKey: UnknownKey) => [
	"BatchMode=yes",
	// A machine that doesn't answer fails fast, so aett can try another way to it.
	"ConnectTimeout=10",
	"PasswordAuthentication=no",
	"IdentityFile=none",
	`UserKnownHostsFile=${sshConfigPath(knownHosts)}`,
	"GlobalKnownHostsFile=/dev/null",
	`HostKeyAlias=${name}`,
	`StrictHostKeyChecking=${unknownKey === "record" ? "accept-new" : "yes"}`,
	"CheckHostIP=no",
];

// Quotes an argument of ProxyCommand: for the shell that runs it, with % kept literal for ssh.
const proxyArgument = (value: string) => shellQuote(value).replaceAll("%", "%%");

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
		) => Effect.Effect<
			Connection,
			SshError | EngineError | PlatformError.PlatformError,
			Scope.Scope
		>;
		/**
		 * Logs in as root with the operators' keys from the SSH agent to a
		 * machine aett is about to install, whatever runs on it: another Linux it
		 * switches into the installer, or that installer. Its host key changes
		 * with every boot, so it is not checked.
		 */
		readonly takeover: (
			host: Host,
		) => Effect.Effect<
			Connection,
			SshError | EngineError | PlatformError.PlatformError,
			Scope.Scope
		>;
		/**
		 * Logs in to an installed machine as root with the operator's key from the
		 * SSH agent and keeps the connection open for the scope. The host key is
		 * checked against `knownHosts` under the machine's name, whatever its
		 * address. One `knownHosts` lacks is recorded there on first contact,
		 * unless `unknownKey` is "refuse".
		 */
		readonly machine: (
			name: string,
			host: Host,
			knownHosts: string,
			unknownKey?: UnknownKey,
		) => Effect.Effect<
			Connection,
			SshError | EngineError | PlatformError.PlatformError,
			Scope.Scope
		>;
		/**
		 * Logs in to a guest as `machine` does, at its `address` on its host's
		 * bridge, through the open connection to its host.
		 */
		readonly guest: (
			name: string,
			address: string,
			knownHosts: string,
			via: Connection,
			unknownKey?: UnknownKey,
		) => Effect.Effect<
			Connection,
			SshError | EngineError | PlatformError.PlatformError,
			Scope.Scope
		>;
	}
>()("aett/adapters/Ssh") {
	static readonly layer = Layer.effect(
		Ssh,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const engine = yield* Engine;

			// Holds the control socket. Socket paths are limited to about 100 bytes, and the Mac's per-user temp directory is long.
			const temporaryDirectory = fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "aett-" });

			// Opens the master connection to root on `host` for the scope and returns the connection that reuses it.
			const open = Effect.fnUntraced(function* (host: Host, directory: string, login: Login) {
				const ssh = path.join(yield* engine.tools, "ssh");
				const destination = `root@${host.name}`;

				// Shared by the master, the commands that reuse it and other programs that run ssh.
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
									message: `Could not log in to ${login.target} at ${formatHost(host)}:\n${stderr}${unreachedHint(host, stderr)}`,
								}),
						),
					),
					() => Effect.ignore(exec(["-O", "exit", destination], {})),
				);

				// Runs a remote command; a failure shows the last lines of its stderr unless they streamed already.
				const remote = (stderr: "pipe" | "inherit") =>
					Effect.fn("Ssh.run")(function* (command: string, input?: string) {
						const result = yield* exec([destination, command], {
							stderr,
							stdin: input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(input)),
						});

						if (result.exitCode !== 0) {
							const tail = result.stderr.split("\n").slice(-20).join("\n");

							return yield* new SshError({
								message:
									`${command} failed on ${formatHost(host)} with exit code ${result.exitCode}.\n${tail}`.trim(),
								exitCode: result.exitCode,
							});
						}

						return result.stdout;
					});

				return {
					destination,
					sshOptions: options,
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

			const takeover = Effect.fn("Ssh.takeover")(function* (host: Host) {
				return yield* open(host, yield* temporaryDirectory, {
					target: "the machine",
					options: [
						"BatchMode=yes",
						"ConnectTimeout=10",
						"PasswordAuthentication=no",
						"KbdInteractiveAuthentication=no",
						"IdentityFile=none",
						"StrictHostKeyChecking=no",
						"UserKnownHostsFile=/dev/null",
					],
					env: {},
				});
			});

			const machine = Effect.fn("Ssh.machine")(function* (
				name: string,
				host: Host,
				knownHosts: string,
				unknownKey: UnknownKey = "record",
			) {
				return yield* open(host, yield* temporaryDirectory, {
					target: name,
					options: machineOptions(name, knownHosts, unknownKey),
					env: {},
				});
			});

			const guest = Effect.fn("Ssh.guest")(function* (
				name: string,
				address: string,
				knownHosts: string,
				via: Connection,
				unknownKey: UnknownKey = "record",
			) {
				const ssh = path.join(yield* engine.tools, "ssh");

				// The host's master connection carries the guest's: ssh -W through it to the guest's sshd.
				// ssh expands %h and %p and runs the rest with a shell.
				const proxy = [
					...[ssh, ...via.sshOptions].map(proxyArgument),
					"-W",
					"%h:%p",
					proxyArgument(via.destination),
				].join(" ");

				return yield* open({ name: address, port: 22 }, yield* temporaryDirectory, {
					target: name,
					options: [...machineOptions(name, knownHosts, unknownKey), `ProxyCommand=${proxy}`],
					env: {},
				});
			});

			return Ssh.of({ installer, takeover, machine, guest });
		}),
	);
}

// When an mDNS name led nowhere, the machine's address is the way around it.
const unreachedHint = (host: Host, stderr: string) =>
	host.name.endsWith(".local") && !stderr.includes("Permission denied")
		? `\nIf ${host.name} doesn't reach the machine, pass its IP address with --host.`
		: "";

// How aett logs in to one kind of host.
interface Login {
	/** Names the host in errors, such as "the installer". */
	readonly target: string;
	/** ssh -o options for authentication and host keys, shared by every command and other programs that run ssh. */
	readonly options: ReadonlyArray<string>;
	/** Environment for the master connection alone, which is the only one that authenticates. */
	readonly env: Readonly<Record<string, string>>;
}
