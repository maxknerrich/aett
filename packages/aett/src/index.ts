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

/** What a stack puts on a machine. */
interface Content {
	/** Pinned packages from nixpkgs, by attribute path. */
	readonly packages?: ReadonlyArray<string>;
	/** Tools that follow their own update channel, such as agent CLIs. */
	readonly fast?: ReadonlyArray<string>;
	/** Catalog services by name; false keeps one off. */
	readonly services?: Services;
}

// What a stack can put on one named machine: apps only on computers, a home only on servers.
type ContentFor<Machine> = Machine extends { readonly role: "computer" }
	? Content & { readonly apps?: ReadonlyArray<string>; readonly home?: never }
	: Content & { readonly home?: true; readonly apps?: never };

// The machines stacks reach: everything but hypervisors.
type Reached<Machines> = {
	[Name in keyof Machines]: Machines[Name] extends { readonly role: "hypervisor" } ? never : Name;
}[keyof Machines] &
	string;

/** A stack: for every server and computer at the top level, per machine under `machines`. */
export type Stack<Machines> = Content & {
	/** GUI applications; they reach only computers. */
	readonly apps?: ReadonlyArray<string>;
	/** A personal user, a home that survives reboots, dotfiles and home backup; reaches only servers. */
	readonly home?: true;
	// With nothing to reach, an empty mapped type would accept any name.
	readonly machines?: [Reached<Machines>] extends [never]
		? { readonly [name: string]: never }
		: { readonly [Name in Reached<Machines>]?: ContentFor<Machines[Name]> };
};

/**
 * Declares the fleet; fleet.ts default-exports the result. `machines` says
 * what exists, keyed by hostname; `stacks` says what is on it.
 *
 * ```ts
 * export default fleet({
 * 	machines: { kronos: hypervisor(), hades: server({ host: "kronos" }) },
 * 	stacks: { tools: { packages: ["git"] } },
 * })
 * ```
 */
export const fleet = <const Machines extends { readonly [name: string]: Declared }>(declaration: {
	readonly machines: Machines &
		CheckedHosts<Machines> & { readonly [Name in keyof Machines]: Known<Machines[Name]> };
	readonly stacks?: { readonly [name: string]: Stack<NoInfer<Machines>> };
}) => declaration;
