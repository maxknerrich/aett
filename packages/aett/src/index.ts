import type { Channel } from "./domain/fleet.ts";
import type { Plugin, Role } from "./domain/plugin.ts";
import type { shipped } from "./domain/shipped.ts";

export { Schema } from "effect";
export type { Channel } from "./domain/fleet.ts";
export { plugin } from "./domain/plugin.ts";
export type { Endpoint, Plugin, Role, Secret, State } from "./domain/plugin.ts";

/** A size such as "32 GiB". */
export type Size = `${number} ${"MiB" | "GiB" | "TiB"}`;

/** Settings of a bare-metal NixOS machine. */
export interface NixosSystem {
	/** Puts the btrfs partition inside LUKS; the passphrase is typed at the console or sent with aett machine unlock. */
	readonly encrypted?: boolean;
	readonly channel?: Channel;
}

/** Settings of a NAS. Its pools root and tank are always inside LUKS. */
export interface NasSystem {
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
	/** The hypervisor, NAS or bare-metal server the VM runs on. */
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

export type NasConfig = BareMetal<NasSystem>;

export type ServerConfig = BareMetal<NixosSystem> | Vm;

export type ComputerConfig = BareMetal<ComputerSystem> | Mac;

/** An appliance that only runs VMs, like Proxmox. Packs never reach it; services can run on it. */
export function hypervisor(): { readonly role: "hypervisor" };
export function hypervisor<const Config extends HypervisorConfig>(
	config: Config & Known<Config> & NoRole,
): Config & { readonly role: "hypervisor" };
export function hypervisor(config: HypervisorConfig = {}) {
	return { ...config, role: "hypervisor" as const };
}

/**
 * Storage that runs services directly and can host VMs. Its two pools, root
 * and tank, are btrfs mirrors inside LUKS; install asks which disks form each.
 * Bulk state lands on tank.
 */
export function nas(): { readonly role: "nas" };
export function nas<const Config extends NasConfig>(
	config: Config & Known<Config> & NoRole,
): Config & { readonly role: "nas" };
export function nas(config: NasConfig = {}) {
	return { ...config, role: "nas" as const };
}

/** A headless machine reached over SSH, on bare metal or as a VM with `host`. */
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
	| (NasConfig & { readonly role: "nas" })
	| (ServerConfig & { readonly role: "server" })
	| (ComputerConfig & { readonly role: "computer" });

// The machines a VM can run on: hypervisors, NASes and bare-metal servers.
type Hosts<Machines> = {
	[Name in keyof Machines]: Machines[Name] extends { readonly role: "hypervisor" | "nas" }
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

/** A tool from a GitHub release, for a `packages` list. */
export interface Release {
	/** The repository, "owner/name". */
	readonly github: string;
	/**
	 * The asset's name. `{version}` is the release's tag without a leading "v";
	 * `{target}` is the platform's Rust target, musl first, then glibc, such as
	 * "x86_64-unknown-linux-musl" or "aarch64-apple-darwin".
	 */
	readonly asset: string;
	/** The binary in the asset, or the asset itself when it is no archive. */
	readonly bin: string;
}

/**
 * Declares a tool from a GitHub release for a `packages` list. aett pins its
 * version and hash in state/pins.json; aett update moves it.
 *
 * ```ts
 * release({ github: "voidzero-dev/vite-plus", asset: "vp-{target}.tar.gz", bin: "vp" })
 * ```
 */
export const release = (source: Release): Release => source;

/**
 * A package: a name aett looks up the first time it sees it, in llm-agents.nix,
 * then nixpkgs on the machine's channel, then nixpkgs unstable, and pins in
 * state/pins.json; or a release().
 */
export type Package = string | Release;

// The names of the machines whose role is one of `Roles`.
type WithRole<Machines, Roles> = {
	[Name in keyof Machines]: Machines[Name] extends { readonly role: Roles } ? Name : never;
}[keyof Machines] &
	string;

// One machine or several.
type On<Name extends string> = Name | ReadonlyArray<Name>;

/** What any entry can add to the machines it is on. */
interface Content {
	/**
	 * Packages by name, whose source aett picks and pins: on Linux
	 * llm-agents.nix, nixpkgs or nixpkgs unstable; on a Mac a Homebrew cask
	 * first, then those, then a Homebrew formula. A name led by its source
	 * takes it from there: "nixpkgs.git", "unstable.zed-editor",
	 * "llm-agents.claude-code", "cask.raycast", "brew.mas". Homebrew's reach
	 * only Macs. Or a release().
	 */
	readonly packages?: ReadonlyArray<Package>;
}

// Every plugin a fleet knows: aett's and its own.
type AllPlugins<Plugins> =
	| (typeof shipped)[number]
	| (Plugins extends ReadonlyArray<infer P> ? P : never);

// The machines a plugin's instances can be.
type Instances<P, Machines> = WithRole<
	Machines,
	P extends { readonly roles: ReadonlyArray<infer R> } ? R : Role
>;

// The options a plugin's entry takes besides on and packages.
type OptionsOf<P> = P extends Plugin<string, infer Options> ? Options : never;

// The entry a plugin takes in `services`, as a machine, machines, or an object.
type PluginEntry<P, Machines> = P extends { readonly always: true }
	? never
	: P extends { readonly single: true }
		? Instances<P, Machines> | (Content & { readonly on: Instances<P, Machines> } & OptionsOf<P>)
		:
				| On<Instances<P, Machines>>
				| (Content & { readonly on?: On<Instances<P, Machines>> } & OptionsOf<P>);

// A pack of the fleet's own: content for every machine but hypervisors, or for those it is on.
type PackEntry<Machines> =
	| On<WithRole<Machines, "nas" | "server" | "computer">>
	| (Content & { readonly on?: On<WithRole<Machines, "nas" | "server" | "computer">> });

// What an entry must be: a machine or a list of them out of the allowed ones, or an object without
// keys the entry type lacks, which a generic's inference would let pass. The machines are checked
// apart, because a string intersected with an object type of optional keys accepts any string.
type Exact<Value, Allowed> = Value extends string | ReadonlyArray<unknown>
	? Value extends Allowed
		? unknown
		: Extract<Allowed, string | ReadonlyArray<unknown>>
	: Allowed & {
			readonly [
				Key in Exclude<keyof Value, keyof Exclude<Allowed, string | ReadonlyArray<unknown>>>
			]: never;
		};

// The names of plugins.
type NameOf<P> = P extends { readonly name: infer Name } ? Name : never;

// Each entry checked against what its name is: one of the plugins, or else a pack.
type CheckedServices<Services, Machines, Plugins> = {
	readonly [Name in keyof Services]: Name extends NameOf<AllPlugins<Plugins>>
		? Exact<
				Services[Name],
				PluginEntry<Extract<AllPlugins<Plugins>, { readonly name: Name }>, Machines>
			>
		: Exact<Services[Name], PackEntry<Machines>>;
};

/**
 * Declares the fleet; fleet.ts default-exports the result. `user` names the
 * fleet's one person, whom every machine but a hypervisor has. `machines` is
 * hardware, keyed by hostname. `services` puts things on them: a known name
 * is a service aett ships or a plugin from `plugins`, any other name is a
 * pack of your own. An entry is the machine it is on, a list of them, or an
 * object with `on`, `packages`, `apps` and a service's options; without `on`
 * it is on every machine it can be. `home/<name>/` follows its entry, and
 * `home/default/` goes to every machine with the user.
 *
 * ```ts
 * export default fleet({
 * 	user: "mkn",
 * 	machines: { kronos: hypervisor(), hades: server({ host: "kronos" }) },
 * 	services: { backup: "kronos", tools: { packages: ["git", "claude-code"] } },
 * })
 * ```
 */
export const fleet = <
	const Machines extends { readonly [name: string]: Declared },
	const Services extends { readonly [name: string]: unknown },
	const Plugins extends ReadonlyArray<Plugin> = readonly [],
>(declaration: {
	/** The login name of the fleet's user, whom every machine but a hypervisor has. */
	readonly user?: string;
	readonly machines: Machines &
		CheckedHosts<Machines> & { readonly [Name in keyof Machines]: Known<Machines[Name]> };
	readonly services?: Services &
		CheckedServices<NoInfer<Services>, NoInfer<Machines>, NoInfer<Plugins>>;
	/** Plugins of your own, each placed by the entry of its name in `services`. */
	readonly plugins?: Plugins;
}) => declaration;
