import { Schema } from "effect";
import { type Plugin, plugin } from "./plugin.ts";

// The plugins aett ships. Their modules and dotfiles live in the package's plugins/<name>/.

/**
 * Tailscale on every machine: aett reaches machines over the tailnet and
 * nowhere else. A NixOS machine joins once the operator approves it; a Mac
 * gets the Tailscale app, which its owner signs in to.
 */
export const tailscale = plugin({
	name: "tailscale",
	always: true,
	package: "tailscale",
	macApp: "tailscale-app",
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

/**
 * T3 Code's server, which runs coding agents and serves the T3 Code app over
 * HTTPS on the tailnet. The entry names the machines; on each, `t3-pair`
 * prints the link that pairs a device.
 */
export const t3code = plugin({
	name: "t3code",
	/** stable, the default, is T3 Code as llm-agents.nix pins it; nightly is T3 Code's own build, which updates itself on every start. */
	options: Schema.Struct({ channel: Schema.optionalKey(Schema.Literals(["stable", "nightly"])) }),
	roles: ["server", "computer"],
	systems: ["nixos"],
	package: "t3code",
	endpoints: { web: { port: 3773, web: true } },
	health: "systemctl is-active --quiet t3code && echo serving || { echo 'not running'; exit 1; }",
});

/**
 * CLIProxyAPI, which serves the coding agents' subscriptions as OpenAI-,
 * Claude- and Gemini-compatible APIs over HTTPS on the tailnet, without
 * client keys. It keeps the logins in the fleet's user's home. Its web panel
 * at /management.html takes the password aett asks for.
 */
export const cliProxy = plugin({
	name: "cli-proxy",
	roles: ["server", "computer"],
	systems: ["nixos"],
	package: "cli-proxy-api",
	endpoints: { api: { port: 8317, web: true } },
	secrets: { panel: { prompt: "A password for CLIProxyAPI's web panel" } },
	health:
		"systemctl is-active --quiet cli-proxy-api && echo serving || { echo 'not running'; exit 1; }",
});

/** Every plugin aett ships. */
export const shipped = [tailscale, backup, omintosh, t3code, cliProxy] as const;

/** The plugins aett ships, as any plugin. */
export const shippedPlugins: ReadonlyArray<Plugin> = shipped;
