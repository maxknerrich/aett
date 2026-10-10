import { Predicate, type Schema } from "effect";
import type { Channel } from "./domain/fleet.ts";
import type { Role } from "./domain/plugin.ts";
import type { shipped } from "./domain/shipped.ts";

export { Schema } from "effect";
export type { Channel } from "./domain/fleet.ts";
export { service } from "./domain/plugin.ts";
export type { Endpoint, Plugin as Service, Role, Secret, State } from "./domain/plugin.ts";

interface Tagged<Tag extends string> {
	/** Words that services and packages target instead of machines, such as "dev". */
	readonly tags?: ReadonlyArray<Tag>;
}

/** A bare-metal NixOS machine's settings. */
export interface NixosSettings<Tag extends string = string> extends Tagged<Tag> {
	/** Puts the btrfs partition inside LUKS; the passphrase is typed at the console or sent with aett machine unlock. */
	readonly encrypted?: boolean;
	/** Its nixpkgs: stable for servers and hypervisors, unstable for computers, unless set. */
	readonly channel?: Channel;
}

/** A bare-metal NixOS computer's settings. */
export interface ComputerSettings<Tag extends string = string> extends NixosSettings<Tag> {
	/** Values arrive with graphical NixOS. */
	readonly desktop?: string;
}

/** A NAS's settings. Its pools root and tank are always inside LUKS. */
export interface NasSettings<Tag extends string = string> extends Tagged<Tag> {
	readonly channel?: Channel;
}

/** A Mac's settings. */
export interface MacSettings<Tag extends string = string> extends Tagged<Tag> {
	/** Its nixpkgs and nix-darwin: unstable unless set to stable. */
	readonly channel?: Channel;
}

/** A VM's settings. Its host builds its system and shares its Nix store with it. */
export interface VmSettings<
	Host extends string = string,
	Tag extends string = string,
> extends Tagged<Tag> {
	/** The hypervisor, NAS or bare-metal server it runs on. */
	readonly host: Host;
	/** Defaults to 2. */
	readonly cpu?: number;
	/** In GiB. Defaults to 2; at least 0.5. */
	readonly memory?: number;
	/** The GiB of the volume that holds /home, /var/lib and /var/log. Counts when the volume is made. Defaults to 20; at least 1. */
	readonly disk?: number;
	readonly channel?: Channel;
}

// Each function's result feeds no inference back: inside fleet({ machines }), the type fleet() expects
// would otherwise give a machine without tags every tag there is.

/** An appliance that only runs VMs, like Proxmox. Packages never reach it; services can run on it. */
export const hypervisor = <const Tag extends string = never>(
	settings: NixosSettings<Tag> = {},
): NoInfer<NixosSettings<Tag> & { readonly role: "hypervisor" }> => ({
	...settings,
	role: "hypervisor",
});

/**
 * Storage that runs services directly and can host VMs. Its two pools, root
 * and tank, are btrfs mirrors inside LUKS; install asks which disks form each.
 * Bulk state lands on tank.
 */
export const nas = <const Tag extends string = never>(
	settings: NasSettings<Tag> = {},
): NoInfer<NasSettings<Tag> & { readonly role: "nas" }> => ({ ...settings, role: "nas" });

/** A headless bare-metal NixOS machine reached over SSH. */
export const server = <const Tag extends string = never>(
	settings: NixosSettings<Tag> = {},
): NoInfer<NixosSettings<Tag> & { readonly role: "server" }> => ({ ...settings, role: "server" });

/** A bare-metal NixOS machine someone sits in front of. */
export const computer = <const Tag extends string = never>(
	settings: ComputerSettings<Tag> = {},
): NoInfer<ComputerSettings<Tag> & { readonly role: "computer" }> => ({
	...settings,
	role: "computer",
});

/** A Mac, which nix-darwin takes over in place. */
export const mac = <const Tag extends string = never>(
	settings: MacSettings<Tag> = {},
): NoInfer<MacSettings<Tag> & { readonly role: "computer"; readonly os: "macos" }> => ({
	...settings,
	role: "computer",
	os: "macos",
});

/** A server VM on a hypervisor, a NAS or a bare-metal server. */
export const vm = <const Host extends string, const Tag extends string = never>(
	settings: VmSettings<Host, Tag>,
): NoInfer<VmSettings<Host, Tag> & { readonly role: "server" }> => ({
	...settings,
	role: "server",
});

// A machine as the functions above return it.
type Machine = { readonly role: "hypervisor" | "nas" | "server" | "computer" } & Tagged<string> & {
		readonly host?: string;
		readonly os?: "macos";
	};

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

// Every tag a machine carries.
type TagsOf<Machines> = {
	[Name in keyof Machines]: Machines[Name] extends Tagged<infer Tag> ? Tag : never;
}[keyof Machines];

/** Where something goes: a machine, a tag, or every machine it fits with "default". */
export type Target<Machines> = "default" | (keyof Machines & string) | TagsOf<Machines>;

// A target or several.
type Targets<Machines> = Target<Machines> | ReadonlyArray<Target<Machines>>;

/** A tool from a GitHub release, for a packages list. */
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
 * Declares a tool from a GitHub release for a packages list, for one aett
 * doesn't know by name. aett pins its version and hash in state/pins.json;
 * aett update moves it.
 *
 * ```ts
 * release({ github: "owner/tool", asset: "tool-{target}.tar.gz", bin: "tool" })
 * ```
 */
export const release = (source: Release): Release => source;

/**
 * The names in each package registry. aett writes them into the fleet's
 * .aett/packages.d.ts from its pins and Homebrew's catalog, so the editor
 * completes them; until then any name goes.
 */
// oxlint-disable-next-line typescript/no-empty-interface -- the fleet's generated declaration fills it in.
export interface Registries {}

/**
 * The fleet's own services, from services/<name>/. aett writes them into the
 * fleet's .aett/services.d.ts whenever it reads the fleet.
 */
// oxlint-disable-next-line typescript/no-empty-interface -- the fleet's generated declaration fills it in.
export interface Services {}

/** The registries a package can come from, as a name leads it: nixpkgs.git. */
export type RegistryName = "nixpkgs" | "unstable" | "llm-agents" | "cask" | "brew";

// A registry's names: the generated ones, or any.
type NamesIn<R extends RegistryName> = R extends keyof Registries ? Registries[R] & string : string;

/** A registry's packages by name, each that name led by its source: nixpkgs.git is "nixpkgs.git". */
export type Registry<R extends RegistryName> = {
	readonly [Name in NamesIn<R>]: `${R}.${Name}`;
};

/**
 * A package: a name aett picks the source of the first time it sees it and
 * pins in state/pins.json, completed from every registry once generated; a
 * registry's package, such as nixpkgs.git or cask.raycast; or a release().
 * On Linux llm-agents.nix comes first, then nixpkgs on the machine's channel,
 * then nixpkgs unstable; on a Mac a Homebrew cask, then those, then a
 * Homebrew formula. Homebrew's reach only Macs.
 */
// `string & {}` keeps any name allowed without losing the completion of the known ones.
export type Package = NamesIn<RegistryName> | (string & {}) | Release;

declare global {
	/** nixpkgs's packages, on the machine's channel: nixpkgs.git. */
	const nixpkgs: Registry<"nixpkgs">;
	/** nixpkgs unstable's packages: unstable["zed-editor"]. */
	const unstable: Registry<"unstable">;
	/** llm-agents.nix's packages: llmAgents["claude-code"]. */
	const llmAgents: Registry<"llm-agents">;
	/** Homebrew's casks, on Macs: cask.raycast. */
	const cask: Registry<"cask">;
	/** Homebrew's formulae, on Macs: brew.mas. */
	const brew: Registry<"brew">;
}

// A registry as fleet.ts reads names off it: each name it reads is that name led by the registry.
const registry = (source: RegistryName) =>
	new Proxy({}, { get: (_, name) => (Predicate.isString(name) ? `${source}.${name}` : undefined) });

// The registries are globals, so fleet.ts uses them without importing them; importing fleet sets them.
Object.assign(globalThis, {
	nixpkgs: registry("nixpkgs"),
	unstable: registry("unstable"),
	llmAgents: registry("llm-agents"),
	cask: registry("cask"),
	brew: registry("brew"),
});

// The fleet's own services, each with its folder's name; none until aett generates them.
type OwnServices = {
	[Name in keyof Services]: Services[Name] & { readonly name: Name };
}[keyof Services];

// Every service a fleet can place: aett's and its own.
type AllServices =
	| (typeof shipped)[number]
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- never until the fleet's declaration fills Services in.
	| OwnServices;

// The options a service takes, any of them; unknown for a service without.
type OptionsOf<S> = S extends { readonly options: Schema.Decoder<infer Options> }
	? Partial<Options>
	: unknown;

// The settings a service takes per target: its options, or an empty object for a service without.
type SettingsOf<S> =
	unknown extends OptionsOf<S> ? { readonly [key: string]: never } : OptionsOf<S>;

// The roles a service's instances may have.
type RolesOf<S> = S extends { readonly roles: ReadonlyArray<infer R> } ? R : Role;

// The machines a service's server can be.
type ServersOf<S, Machines> = {
	[Name in keyof Machines]: Machines[Name] extends { readonly role: RolesOf<S> } ? Name : never;
}[keyof Machines] &
	string;

// What a service's entry is: a server and whom to leave out for a service with clients; else
// targets, or settings by target.
type EntryOf<S, Machines> = S extends { readonly clients: true }
	? {
			readonly server: ServersOf<S, Machines>;
			readonly exclude?: Targets<Machines>;
		} & OptionsOf<S>
	: Targets<Machines> | { readonly [T in Target<Machines>]?: SettingsOf<S> };

/** The fleet's services by name: aett's, or its own from services/<name>/. */
export type ServicesOf<Machines> = {
	readonly [S in AllServices as S extends { readonly always: true } ? never : S["name"]]?: EntryOf<
		S,
		Machines
	>;
};

// A group of packages: its targets and their packages.
type Group<Machines> = { readonly [T in Target<Machines>]?: ReadonlyArray<Package> };

// Each key of packages: a target with its packages, or a group of its own name, which takes targets only.
type CheckedPackages<Packages, Machines> = {
	readonly [Key in keyof Packages]: Key extends Target<Machines>
		? ReadonlyArray<Package>
		: Group<Machines> & {
				readonly [Extra in Exclude<keyof Packages[Key], Target<Machines>>]: never;
			};
};

/**
 * Declares the fleet; fleet.ts default-exports the result. `user` is the
 * fleet's one person, whom every machine but a hypervisor has. `machines` is
 * hardware with tags. `services` places services: a target, a list of them,
 * or settings by target, where `default` applies first, then tags, then the
 * machine; a service with clients, such as backup, names its server.
 * `packages` lists packages by target, or under a group's name by target.
 * Dotfiles follow the same targets: dotfiles/default/, dotfiles/<tag>/ and
 * dotfiles/<machine>/.
 *
 * ```ts
 * export default fleet({
 * 	user: "mkn",
 * 	machines: {
 * 		astraeus: hypervisor({ encrypted: true }),
 * 		zeus: vm({ host: "astraeus", cpu: 6, memory: 16, disk: 200, tags: ["dev"] }),
 * 	},
 * 	services: { t3code: "zeus" },
 * 	packages: { dev: ["git", "gh"], agents: { zeus: ["pi", "vite-plus"] } },
 * })
 * ```
 */
export const fleet = <
	const Machines extends { readonly [name: string]: Machine },
	const Packages extends { readonly [key: string]: unknown } = Record<never, never>,
>(
	declaration: FleetDeclaration<Machines, Packages>,
	// The result's type feeds no inference back, so a call around fleet() can't widen its machines.
): NoInfer<FleetDeclaration<Machines, Packages>> => declaration;

/** What fleet() takes: its machines, and services and packages checked against them. */
// A type alias, not an interface, so a declaration still reads as the plain record aett decodes.
export type FleetDeclaration<Machines, Packages> = {
	/** The login name of the fleet's user, whom every machine but a hypervisor has. */
	readonly user?: string;
	readonly machines: Machines & CheckedHosts<Machines>;
	readonly services?: ServicesOf<NoInfer<Machines>>;
	readonly packages?: Packages & CheckedPackages<NoInfer<Packages>, NoInfer<Machines>>;
};
