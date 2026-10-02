import type { Channel } from "./domain/fleet.ts";
import type { Services } from "./domain/stacks.ts";

export type { Channel, Role } from "./domain/fleet.ts";

/** A size such as "32 GiB". */
export type Size = `${number} ${"MiB" | "GiB" | "TiB"}`;

/** Settings of a bare-metal NixOS machine. */
export interface NixosSystem {
	/** Puts the btrfs partition inside LUKS; the passphrase is typed at the console on every boot. */
	readonly encrypted?: boolean;
	readonly channel?: Channel;
}

/** Settings of a VM. Its host builds its system and shares its Nix store with it. */
export interface VmSystem {
	/** Defaults to 2. */
	readonly cpu?: number;
	/** Defaults to "2 GiB"; at least "512 MiB". */
	readonly memory?: Size;
	/** The size of the volume that holds /home, /var/lib and /var/log. Counts when the volume is made. Defaults to "20 GiB"; at least "1 GiB". */
	readonly disk?: Size;
	readonly channel?: Channel;
}

/** Settings of a bare-metal NixOS computer. */
export interface ComputerSystem extends NixosSystem {
	/** Values arrive with graphical NixOS. */
	readonly desktop?: string;
}

// `Settings` with every other kind's settings ruled out. TypeScript checks extra keys
// against all members of a union, so without this `memory` would pass next to `encrypted`.
type Only<Settings, Others> = Settings & {
	readonly [Key in Exclude<keyof Others, keyof Settings>]?: never;
};

type AnySystem = ComputerSystem & VmSystem;

interface BareMetal<System> {
	readonly os?: "nixos";
	readonly host?: never;
	readonly system?: Only<System, AnySystem>;
}

interface Vm {
	/** The hypervisor or bare-metal server the VM runs on. */
	readonly host: string;
	readonly os?: never;
	readonly system?: Only<VmSystem, AnySystem>;
}

interface Mac {
	readonly os: "macos";
	readonly host?: never;
	readonly system?: { readonly [key: string]: never };
}

// Rejects keys a config doesn't know, at its top level and in its system. Inferring a
// generic skips TypeScript's usual check for unknown keys in object literals.
type Known<Config> = {
	readonly [Key in Exclude<keyof Config, "role" | "os" | "host" | "system">]: never;
} & (Config extends { readonly system: infer System }
	? { readonly system: { readonly [Key in Exclude<keyof System, keyof AnySystem>]: never } }
	: unknown);

// The function picks the role, so its config can't name one.
interface NoRole {
	readonly role?: never;
}

export type HypervisorConfig = BareMetal<NixosSystem>;

export type ServerConfig = BareMetal<NixosSystem> | Vm;

export type ComputerConfig = BareMetal<ComputerSystem> | Mac;

/** An appliance that only runs VMs, like Proxmox. Stacks never reach it. */
export function hypervisor(): { readonly role: "hypervisor" };
export function hypervisor<const Config extends HypervisorConfig>(
	config: Config & Known<Config> & NoRole,
): Config & { readonly role: "hypervisor" };
export function hypervisor(config: HypervisorConfig = {}) {
	return { ...config, role: "hypervisor" as const };
}

/** A headless machine reached over SSH, on bare metal or as a VM with `host`. Its stacks make it what it is. */
export function server(): { readonly role: "server" };
export function server<const Config extends ServerConfig>(
	config: Config & Known<Config> & NoRole,
): Config & { readonly role: "server" };
export function server(config: ServerConfig = {}) {
	return { ...config, role: "server" as const };
}

/** A machine someone sits in front of: bare-metal NixOS, or a Mac with `os: "macos"`. Always graphical. */
export function computer(): { readonly role: "computer" };
export function computer<const Config extends ComputerConfig>(
	config: Config & Known<Config> & NoRole,
): Config & { readonly role: "computer" };
export function computer(config: ComputerConfig = {}) {
	return { ...config, role: "computer" as const };
}

// A machine as a role function returns it: its role with that role's config.
type Declared =
	| (HypervisorConfig & { readonly role: "hypervisor" })
	| (ServerConfig & { readonly role: "server" })
	| (ComputerConfig & { readonly role: "computer" });

// The machines a VM can run on: hypervisors and bare-metal servers.
type Hosts<Machines> = {
	[Name in keyof Machines]: Machines[Name] extends { readonly role: "hypervisor" }
		? Name
		: Machines[Name] extends { readonly role: "server"; readonly host?: undefined }
			? Name
			: never;
}[keyof Machines] &
	string;

// Pins each VM's host to the machines it can run on, so another name is a type error.
type CheckedHosts<Machines> = {
	[Name in keyof Machines]: Machines[Name] extends { readonly host: string }
		? { readonly host: Hosts<Machines> }
		: unknown;
};

/** A tool from a GitHub release, for a stack's `fast` list. */
export interface Release {
	/** The repository, "owner/name". */
	readonly github: string;
	/**
	 * The asset's name. `{version}` is the release's tag without a leading "v";
	 * `{target}` is the platform's Rust target, musl first, then glibc, such as
	 * "x86_64-unknown-linux-musl".
	 */
	readonly asset: string;
	/** The binary in the asset, or the asset itself when it is no archive. */
	readonly bin: string;
}

/**
 * Declares a tool from a GitHub release for a stack's `fast` list. aett pins
 * its version and hash in state/pins.json; aett update moves it.
 *
 * ```ts
 * release({ github: "voidzero-dev/vite-plus", asset: "vp-{target}.tar.gz", bin: "vp" })
 * ```
 */
export const release = (source: Release): Release => source;

/** What a stack puts on a machine. */
interface Content {
	/** Pinned packages from nixpkgs on the machine's channel, by attribute path. */
	readonly packages?: ReadonlyArray<string>;
	/** Pinned packages from nixpkgs unstable, whatever the machine's channel, for a tool whose stable version is too old. */
	readonly unstable?: ReadonlyArray<string>;
	/**
	 * Dev tools from the fastest source: a release() declared here, or else
	 * the llm-agents.nix package of that name. Pinned like everything else.
	 */
	readonly fast?: ReadonlyArray<string | Release>;
	/** Catalog services by name; false keeps one off. */
	readonly services?: Services;
	/**
	 * Dotfile sets by name, each a directory under the fleet's home/. A machine
	 * with at least one set has the fleet's user and those sets in its home.
	 */
	readonly home?: ReadonlyArray<string>;
}

// What a stack can put on one named machine: apps only on computers.
type ContentFor<Machine> = Machine extends { readonly role: "computer" }
	? Content & { readonly apps?: ReadonlyArray<string> }
	: Content & { readonly apps?: never };

// The machines stacks reach: everything but hypervisors.
type Reached<Machines> = {
	[Name in keyof Machines]: Machines[Name] extends { readonly role: "hypervisor" } ? never : Name;
}[keyof Machines] &
	string;

/** A stack: for every server and computer at the top level, per machine under `machines`. */
export type Stack<Machines> = Content & {
	/** GUI applications; they reach only computers. */
	readonly apps?: ReadonlyArray<string>;
	// With nothing to reach, an empty mapped type would accept any name.
	readonly machines?: [Reached<Machines>] extends [never]
		? { readonly [name: string]: never }
		: { readonly [Name in Reached<Machines>]?: ContentFor<Machines[Name]> };
};

/**
 * Declares the fleet; fleet.ts default-exports the result. `user` names the
 * fleet's one person, `machines` says what exists, keyed by hostname, and
 * `stacks` says what is on it.
 *
 * ```ts
 * export default fleet({
 * 	user: "mkn",
 * 	machines: { kronos: hypervisor(), hades: server({ host: "kronos" }) },
 * 	stacks: { tools: { packages: ["git"], home: ["shell"] } },
 * })
 * ```
 */
export const fleet = <const Machines extends { readonly [name: string]: Declared }>(declaration: {
	/** The login name of the fleet's user, which every machine with a home has. Required once one does. */
	readonly user?: string;
	readonly machines: Machines &
		CheckedHosts<Machines> & { readonly [Name in keyof Machines]: Known<Machines[Name]> };
	readonly stacks?: { readonly [name: string]: Stack<NoInfer<Machines>> };
}) => declaration;
