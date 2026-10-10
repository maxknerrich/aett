import type { Schema } from "effect";

/** The machine roles: hypervisor, nas, server and computer. */
export type Role = "hypervisor" | "nas" | "server" | "computer";

/**
 * A secret a plugin's machines read. aett makes it, or asks for it once, the
 * first time a build needs it, and keeps it encrypted in the fleet.
 *
 * `per` says how many there are and who reads them: one for the fleet, read
 * by every machine the plugin configures (the default); one per instance,
 * read by that instance; or one per client, read by that client and every
 * instance.
 */
export type Secret =
	| {
			/**
			 * A random password, or a self-signed TLS certificate with its key in one
			 * PEM file. Every machine the plugin configures sees a certificate's
			 * SHA-256 fingerprint.
			 */
			readonly generate: "password" | "certificate";
			readonly per?: "fleet" | "instance" | "client";
	  }
	| {
			/** What aett asks for. */
			readonly prompt: string;
			readonly per?: "fleet" | "instance" | "client";
	  };

/** A port a plugin's instances serve on the tailnet. */
export interface Endpoint {
	readonly port: number;
	/**
	 * Served over HTTPS by Caddy with the machine's ts.net certificate, at
	 * https://<machine>.<tailnet>.ts.net:<port>. The service itself listens on
	 * 127.0.0.1:<port>. Without it the service listens on the port itself.
	 */
	readonly web?: boolean;
}

/** A directory a plugin keeps across reboots. */
export interface State {
	/**
	 * Large data such as media or a backup repository. It lands on a NAS's
	 * tank pool; elsewhere it is ordinary state.
	 */
	readonly bulk?: boolean;
}

/**
 * A service aett can put on machines: its options, its Nix modules and what
 * the rest of aett reads from it. A fleet's `services` entry of the same name
 * places it. aett ships tailscale, backup, omintosh, t3code and cli-proxy; a
 * fleet's own live in services/<name>/, declared by `service()`.
 */
export interface Plugin<Name extends string = string, Options = unknown> {
	readonly name: Name;
	/** The settings its entry takes per target, which its modules read. */
	readonly options?: Schema.Decoder<Options>;
	/**
	 * A directory with `nixos.nix` and `darwin.nix`, the modules aett imports on
	 * the machines it configures, and a `dotfiles/` tree that lands in the user's
	 * home on its instances, where the fleet's own `dotfiles/<name>/` wins. Shipped
	 * plugins live in aett.
	 */
	readonly directory?: string | URL;
	/** The nixpkgs package its modules run, picked and pinned like any other. */
	readonly package?: string;
	/** Ports by name. */
	readonly endpoints?: { readonly [name: string]: Endpoint };
	/** Secrets by name. */
	readonly secrets?: { readonly [name: string]: Secret };
	/** Directories by absolute path that survive reboots and that backup covers. */
	readonly state?: { readonly [path: string]: State };
	/** A shell command run on each machine the plugin configures; exit status 0 means healthy, and its first line of output says how. */
	readonly health?: string;
	/** The roles its instances may have. Defaults to every role. */
	readonly roles?: ReadonlyArray<Role>;
	/** The systems it has modules for. Defaults to both. */
	readonly systems?: ReadonlyArray<"nixos" | "darwin">;
	/** Exactly one instance, which the entry must name. */
	readonly single?: boolean;
	/** On every machine, with no entry of its own. */
	readonly always?: boolean;
	/**
	 * Its modules also configure every other machine that has the fleet's user
	 * or service state, as a client of the instances.
	 */
	readonly clients?: boolean;
}

/** Declares a service aett ships. */
export const plugin = <const Definition extends Plugin>(definition: Definition) => definition;

/**
 * Declares a service of the fleet's own, as the default export of
 * services/<name>/service.ts, next to its nixos.nix, darwin.nix and dotfiles/.
 * Its name is the folder's. A folder without service.ts is a service without
 * settings.
 *
 * ```ts
 * export default service({
 * 	options: Schema.Struct({ greeting: Schema.optional(Schema.String) }),
 * 	endpoints: { web: { port: 8080, web: true } },
 * 	health: "curl -fsS http://127.0.0.1:8080",
 * })
 * ```
 */
export const service = <const Definition extends Omit<Plugin, "name" | "directory">>(
	definition: Definition,
) => definition;

/** A rule the tailnet's policy needs so machines reach a plugin's endpoints: who, where, which ports. */
export interface Grant {
	readonly src: ReadonlyArray<string>;
	readonly dst: ReadonlyArray<string>;
	readonly ip: ReadonlyArray<string>;
}
