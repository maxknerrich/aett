import { type Plugin, plugin } from "./plugin.ts";

// The plugins aett ships. Their modules and home trees live in the package's plugins/<name>/.

/**
 * Tailscale on every machine: aett reaches machines over the tailnet and
 * nowhere else. A NixOS machine joins once the operator approves it; a Mac
 * runs the Tailscale app.
 */
export const tailscale = plugin({
	name: "tailscale",
	always: true,
	package: "tailscale",
	health: "tailscale ip -4 | head -n 1",
});

/**
 * Kopia backups. The entry names the repository server; every other machine
 * with the fleet's user or service state backs up its home and that state to
 * it.
 */
export const backup = plugin({
	name: "backup",
	single: true,
	clients: true,
	roles: ["hypervisor", "nas", "server"],
	systems: ["nixos", "darwin"],
	package: "kopia",
	endpoints: { repository: { port: 51515 } },
	secrets: {
		repository: { generate: "password", per: "instance" },
		tls: { generate: "certificate", per: "instance" },
		client: { generate: "password", per: "client" },
	},
	state: { "/var/lib/aett-backup": { bulk: true } },
	health: "aett-backup-health",
});

/** A keyboard-first Mac desktop: Rift tiling, SketchyBar, JankyBorders, Karabiner and macOS defaults. */
export const omintosh = plugin({
	name: "omintosh",
	roles: ["computer"],
	systems: ["darwin"],
});

/** Every plugin aett ships. */
export const shipped = [tailscale, backup, omintosh] as const;

/** The plugins aett ships, as any plugin. */
export const shippedPlugins: ReadonlyArray<Plugin> = shipped;
