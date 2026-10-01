import { Context, type Effect, type Option, type PlatformError, Schema } from "effect";
import type { Connection, SshError } from "../adapters/ssh.ts";
import type { Disk } from "../domain/disk.ts";
import type { Fleet } from "../domain/fleet.ts";
import type { State } from "../domain/state.ts";

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
	message: Schema.String,
}) {}

/** A fleet's build: where the engine wrote it and the machines it can build. */
export interface Build {
	readonly directory: string;
	readonly machines: ReadonlyArray<string>;
}

/** What install puts on a machine besides its system: its SSH host key and, when encrypted, its disk passphrase. */
export interface InstallSecrets {
	readonly hostKey: { readonly privateKey: string; readonly publicKey: string };
	readonly passphrase: Option.Option<string>;
}

/**
 * The system engine: turns a fleet into machine systems, and builds, installs
 * and activates them on machines. The workflows know only these operations;
 * `engine/nix/` implements them with Nix.
 */
export class Engine extends Context.Service<
	Engine,
	{
		/** Directory of the pinned tools aett runs on the controller: ssh, ssh-add, ssh-keygen, sops, age, age-keygen and git. */
		readonly tools: Effect.Effect<string, EngineError>;
		/** Runs the installer's hardware probe on `target`, saves its report in `<root>/state/<name>/` and returns the internal disks it found. */
		readonly discover: (
			root: string,
			name: string,
			target: Connection,
		) => Effect.Effect<ReadonlyArray<Disk>, EngineError | SshError | PlatformError.PlatformError>;
		/** Whether discover has saved the machine's hardware report in `<root>/state/<name>/`. */
		readonly discovered: (
			root: string,
			name: string,
		) => Effect.Effect<boolean, PlatformError.PlatformError>;
		/** Writes the build for `fleet` to `<root>/.aett/build/`. It covers the machines with recorded facts and an install disk. */
		readonly emit: (
			root: string,
			fleet: Fleet,
			state: State,
		) => Effect.Effect<Build, PlatformError.PlatformError>;
		/** Checks a machine's system on the controller, before any machine is contacted. Returns what it evaluated. */
		readonly evaluate: (build: Build, name: string) => Effect.Effect<string, EngineError>;
		/** Copies the build to `target` and builds the machine's system there, streaming the log. Returns the system. */
		readonly buildSystem: (
			build: Build,
			name: string,
			target: Connection,
		) => Effect.Effect<string, EngineError | SshError>;
		/** The system `target` runs now. */
		readonly currentSystem: (target: Connection) => Effect.Effect<string, SshError>;
		/** What changes from the system `target` runs to `system`, as text for the operator; empty when no package changes. */
		readonly changes: (target: Connection, system: string) => Effect.Effect<string, SshError>;
		/** Makes `system` what `target` runs and boots. */
		readonly activate: (target: Connection, system: string) => Effect.Effect<void, SshError>;
		/** From an installer: builds the machine there, erases and formats its disk, places `secrets` and installs the system. */
		readonly install: (
			build: Build,
			name: string,
			target: Connection,
			secrets: InstallSecrets,
		) => Effect.Effect<void, EngineError | SshError>;
	}
>()("aett/engine/Engine") {}
