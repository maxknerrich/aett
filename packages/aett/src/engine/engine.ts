import {
	Context,
	type Effect,
	type Option,
	type PlatformError,
	type Redacted,
	Schema,
} from "effect";
import type { Connection, SshError } from "../adapters/ssh.ts";
import type { Disk } from "../domain/disk.ts";
import type { Channel, Fleet } from "../domain/fleet.ts";
import type { Source } from "../domain/packages.ts";
import type { InputsLock, Pins, Platform } from "../domain/pins.ts";
import type { Extras } from "./nix/fleet-json.ts";
import type { State } from "../domain/state.ts";

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
	message: Schema.String,
}) {}

/** A fleet's build: where the engine wrote it, the machines it can build and which of them are Macs. */
export interface Build {
	readonly directory: string;
	readonly machines: ReadonlyArray<string>;
	readonly macs: ReadonlyArray<string>;
}

/** What the hardware probe tells install: the internal disks, and whether the installer booted via UEFI. */
export interface Discovered {
	readonly disks: ReadonlyArray<Disk>;
	readonly uefi: boolean;
}

/** A node on the tailnet, as it says itself: its IPv4 address, its name there and its tags. */
export interface Joined {
	readonly tailnet: string;
	readonly tailnetName: string;
	readonly tags: ReadonlyArray<string>;
}

/** What an install leaves: the node the machine joined the tailnet as, and an encrypted one's initrd sshd key. */
export interface Installed {
	readonly joined: Joined;
	readonly unlockKey: Option.Option<string>;
}

/** Shows the operator the URL a machine joining the tailnet waits at until they approve it. */
export type Approve = (url: string) => Effect.Effect<void>;

/** A guest as its host sees it: not installed there yet, installed but not running, or running. */
export type GuestState = "absent" | "stopped" | "running";

/** A machine's SSH host key pair, which also derives its age key. */
export interface HostKey {
	readonly privateKey: string;
	readonly publicKey: string;
}

/**
 * What install puts on a machine besides its system: its SSH host key, its
 * guests' host keys and, when encrypted, its disk passphrase.
 */
export interface InstallSecrets {
	readonly hostKey: HostKey;
	readonly guests: ReadonlyMap<string, HostKey>;
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
		/** Directory of the pinned tools aett runs on the controller: ssh, ssh-add, ssh-keygen, sops, age, age-keygen, ssh-to-age, mkpasswd and git. */
		readonly tools: Effect.Effect<string, EngineError>;
		/** Runs the installer's hardware probe on `target`, saves its report in `<root>/state/<name>/` and returns what install needs from it. */
		readonly discover: (
			root: string,
			name: string,
			target: Connection,
		) => Effect.Effect<Discovered, EngineError | SshError | PlatformError.PlatformError>;
		/** The platform the hardware report discover saved in `<root>/state/<name>/` names; none without a report. */
		readonly discovered: (
			root: string,
			name: string,
		) => Effect.Effect<Option.Option<Platform>, EngineError | PlatformError.PlatformError>;
		/** The pins of the engine's inputs that aett is tested with, which a fleet starts from. */
		readonly defaultInputs: Effect.Effect<InputsLock, EngineError | PlatformError.PlatformError>;
		/**
		 * Writes the build for `fleet` to `<root>/.aett/build/`, locked to the
		 * fleet's `pins`, with every plugin's modules. It covers the machines aett
		 * can build and carries the machine secrets the fleet has, for the
		 * machines that read them, and the fingerprints of its certificates.
		 */
		readonly emit: (
			root: string,
			fleet: Fleet,
			state: State,
			extras: Extras,
			pins: Pins,
		) => Effect.Effect<Build, PlatformError.PlatformError>;
		/** Moves the named inputs, or all of them when none are named, from `inputs` to their latest revisions. Returns the new pins. */
		readonly updateInputs: (
			inputs: InputsLock,
			names: ReadonlyArray<string>,
		) => Effect.Effect<InputsLock, EngineError | PlatformError.PlatformError>;
		/**
		 * Which source has each package name on `platform` for a machine on
		 * `channel`, at the revisions `inputs` pins, looked up in order:
		 * llm-agents.nix, nixpkgs on that channel, nixpkgs unstable. None for a
		 * name no source has.
		 */
		readonly packageSources: (
			inputs: InputsLock,
			platform: Platform,
			channel: Channel,
			names: ReadonlyArray<string>,
		) => Effect.Effect<
			ReadonlyMap<string, Option.Option<Source>>,
			EngineError | PlatformError.PlatformError
		>;
		/** Downloads a file on the controller and returns the hash a build pins it by. */
		readonly prefetch: (url: string) => Effect.Effect<string, EngineError>;
		/** Checks a machine's system on the controller, before any machine is contacted. Returns what it evaluated. */
		readonly evaluate: (build: Build, name: string) => Effect.Effect<string, EngineError>;
		/**
		 * The systems the named machines would run if built from `build`, by
		 * name, computed on the controller in one evaluation without building
		 * them. Fails when any of them doesn't evaluate.
		 */
		readonly systemPaths: (
			build: Build,
			names: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, string>, EngineError>;
		/** Copies the build to `target` and builds the machine's system there, streaming the log. Returns the system. */
		readonly buildSystem: (
			build: Build,
			name: string,
			target: Connection,
		) => Effect.Effect<string, EngineError | SshError>;
		/** The system `target` runs now. */
		readonly currentSystem: (target: Connection) => Effect.Effect<string, SshError>;
		/** What changes from system `from` to system `to`, both in `target`'s store, as text for the operator; empty when no package changes. */
		readonly changes: (
			target: Connection,
			from: string,
			to: string,
		) => Effect.Effect<string, SshError>;
		/** Makes `system` what `target` runs and boots. */
		readonly activate: (target: Connection, system: string) => Effect.Effect<void, SshError>;
		/** Whether `host` has `guest` installed, and whether it runs. */
		readonly guestState: (
			host: Connection,
			guest: string,
		) => Effect.Effect<GuestState, EngineError | SshError>;
		/** Builds `guest`'s system on `host`, streaming the log, and makes it what the guest boots next. Returns the system. */
		readonly buildGuest: (
			build: Build,
			guest: string,
			host: Connection,
		) => Effect.Effect<string, EngineError | SshError>;
		/** Whether the running `guest` must restart to run `system`: its kernel, initrd, CPUs, memory or devices changed. */
		readonly needsRestart: (guest: Connection, system: string) => Effect.Effect<boolean, SshError>;
		/** Switches `guest`, running on `host`, to `system` in place, and keeps that system on its host. */
		readonly switchGuest: (
			host: Connection,
			guest: Connection,
			name: string,
			system: string,
		) => Effect.Effect<void, SshError>;
		/** Starts, restarts or stops `guest` on `host`. */
		readonly controlGuest: (
			host: Connection,
			guest: string,
			action: "start" | "restart" | "stop",
		) => Effect.Effect<void, SshError>;
		/** Deletes everything `host` keeps for `guest`, which must not run: its state volume and its identity. */
		readonly removeGuest: (host: Connection, guest: string) => Effect.Effect<void, SshError>;
		/** Puts `guest`'s host key where `host` shares it into the guest, readable by root only. */
		readonly placeGuestKey: (
			host: Connection,
			guest: string,
			hostKey: HostKey,
		) => Effect.Effect<void, SshError>;
		/**
		 * Joins the system `target` runs to the tailnet as `hostname` with `tag`,
		 * once the operator approved it at the URL `approve` gets, unless it is on
		 * the tailnet already.
		 */
		readonly join: (
			target: Connection,
			hostname: string,
			tag: string,
			approve: Approve,
		) => Effect.Effect<Joined, EngineError | SshError>;
		/** `target`'s IPv4 address on its LAN, where an encrypted machine's initrd answers; none without a route out. */
		readonly lanAddress: (target: Connection) => Effect.Effect<Option.Option<string>, SshError>;
		/**
		 * Hands the Wi-Fi networks `target` knows to its initrd, so it reaches its
		 * LAN without a cable. Returns whether the boot loader has yet to put them
		 * into the initrd: they changed, now or before a refresh that failed.
		 */
		readonly unlockWifi: (target: Connection) => Effect.Effect<boolean, SshError>;
		/** Installs `target`'s boot loader again for the system it runs, with its initrd's secrets as they are now. */
		readonly refreshBoot: (target: Connection) => Effect.Effect<void, SshError>;
		/** Builds the Mac `name`'s nix-darwin system on the Mac aett runs on. Returns the system. */
		readonly buildDarwin: (build: Build, name: string) => Effect.Effect<string, EngineError>;
		/** The Brewfile the Mac `name`'s system installs its apps from. */
		readonly brewfile: (build: Build, name: string) => Effect.Effect<string, EngineError>;
		/**
		 * Makes `system` what the Mac aett runs on runs, through sudo, which asks
		 * on the terminal. Its age key goes where sops-nix reads it first.
		 */
		readonly activateDarwin: (
			system: string,
			ageKey: Redacted.Redacted,
		) => Effect.Effect<void, EngineError>;
		/**
		 * From an installer: builds the machine there, joins it to the tailnet
		 * with `tag` once the operator approved it, then erases and formats its
		 * disk, places `secrets` and its tailnet identity and installs the system.
		 * An encrypted machine's initrd gets an sshd key and the Wi-Fi networks
		 * the installer knows, so even its first boot opens over its LAN.
		 */
		readonly install: (
			build: Build,
			name: string,
			target: Connection,
			secrets: InstallSecrets,
			tag: string,
			approve: Approve,
		) => Effect.Effect<Installed, EngineError | SshError>;
	}
>()("aett/engine/Engine") {}
