import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Engine } from "../engine/engine.ts";
import { type Connection, SshError } from "./ssh.ts";

/**
 * The machine aett runs on as a connection, for a Mac that applies to itself:
 * commands run as the operator with aett's pinned tools first on PATH, so the
 * scripts written for NixOS find GNU coreutils.
 */
export const localConnection = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const tools = yield* (yield* Engine).tools;
	const path = `${tools}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;

	const execute = (stderr: "pipe" | "inherit") =>
		Effect.fn("Local.run")(function* (command: string, input?: string) {
			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(
						ChildProcess.make("/bin/sh", ["-c", command], {
							env: { PATH: path },
							extendEnv: true,
							stderr,
							stdin: input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(input)),
						}),
					);

					const [stdout, errors, exitCode] = yield* Effect.all(
						[
							Stream.mkString(Stream.decodeText(handle.stdout)),
							Stream.mkString(Stream.decodeText(handle.stderr)),
							handle.exitCode,
						],
						{ concurrency: "unbounded" },
					);

					return { stdout, errors: errors.trim(), exitCode };
				}),
			).pipe(
				Effect.mapError(
					(error) => new SshError({ message: `Could not run ${command}: ${error.message}` }),
				),
			);

			if (result.exitCode !== 0) {
				return yield* new SshError({
					message:
						`${command} failed with exit code ${result.exitCode}.\n${result.errors.split("\n").slice(-20).join("\n")}`.trim(),
				});
			}

			return result.stdout;
		});

	return {
		destination: "localhost",
		sshOptions: [],
		run: execute("pipe"),
		stream: execute("inherit"),
		local: true,
	} satisfies Connection;
});
