# aett

Declare a fleet of NixOS servers, VMs, a NAS and Macs in one small TypeScript file. aett installs them, keeps them on what the file says, backs them up and reaches every one over your tailnet. Nix does the work underneath; you don't write any.

```ts
import { fleet, hypervisor, mac, nas, vm } from "aett"

export default fleet({
	user: "you",
	machines: {
		kronos: hypervisor({ encrypted: true }),
		zeus: vm({ host: "kronos", cpu: 4, memory: 8, tags: ["dev"] }),
		vault: nas(),
		desk: mac({ tags: ["dev"] }),
	},
	services: {
		backup: { server: "vault" },
		t3code: "zeus",
		omintosh: "desk",
	},
	packages: {
		dev: ["git", "claude-code"],
		desk: ["ghostty", "raycast"],
	},
})
```

## Start

You need Node 24.11 or newer, Nix, and a [Tailscale](https://tailscale.com) tailnet with the Tailscale app on your Mac. A Mac in the fleet gets the app from aett on its first apply.

```sh
npm create aett            # or: pnpm create aett, vp create aett
cd <fleet>
aett tailscale setup       # once: whether aett keeps your tailnet's policy for you
```

Each NixOS machine joins the tailnet once, when aett installs it or a VM first starts: aett opens a login page in your browser and you approve it. It joins tagged with its role, such as `tag:server`. Your tailnet's policy has to list those tags, and grants let the fleet's machines reach each other's services. Give `aett tailscale setup` an OAuth client with Policy File: Write and aett adds them itself; without one, it shows you what to add. Macs are your own devices on the Tailscale app.

On a Mac, `create` offers to add the Mac itself and adopts what Homebrew has on it into its `packages`: the casks, and the formulae you installed. aett installs and pins Homebrew itself through nix-homebrew, taking over an existing install in place. It keeps your new age key, which decrypts the fleet's secrets, in the login keychain. It also puts the key on the clipboard so you can save it in your password manager.

## The declaration

`machines` is hardware, each with a few tags if you like:

| Function | What it is |
|---|---|
| `hypervisor()` | Runs VMs and nothing else. No user, no packages. |
| `nas()` | Storage that runs services and VMs. Two pools, `root` and `tank`, each a btrfs mirror inside LUKS. |
| `server()` | A headless bare-metal NixOS machine. |
| `computer()` | A bare-metal NixOS machine you sit at. |
| `mac()` | A Mac, taken over in place. |
| `vm({ host })` | A server VM on a hypervisor, a NAS or a bare-metal server. `cpu`, `memory` and `disk` are numbers, in GiB. |

A target is a machine, a tag, or `default` for every machine it fits. Every machine also carries its role as a tag: `server` (on bare metal or a VM), `computer`, `nas` or `hypervisor`. `services` and `packages` put things on targets.

`services` places services by name:

- A target, or a list of them: `t3code: "zeus"`.
- Settings by target, which apply in order: `default`, then the machine's tags, then the machine. `whoami: { default: { greeting: "hi" }, zeus: { greeting: "hey" } }`.
- A service with clients names its server, and every other machine with your user is a client unless excluded: `backup: { server: "vault", exclude: ["scratch"] }`.

aett ships `backup` (Kopia), `omintosh` (a keyboard-first Mac desktop), `t3code` (T3 Code's server; `t3-pair` on the machine pairs a device) and `cli-proxy` (CLIProxyAPI, the agents' subscriptions as APIs for the tailnet). Tailscale is always on every machine. A service of your own lives in `services/<name>/`.

`packages` lists packages by target, `dev: ["git"]`, or under a group's name by target, `apps: { desk: ["ghostty"] }`. The first time aett sees a name, it picks the source. On Linux that's llm-agents.nix, else nixpkgs on the machine's channel, else nixpkgs unstable. On a Mac a Homebrew cask comes first, so apps land in /Applications and update themselves, then those, then a Homebrew formula. aett pins the choice per platform in `state/pins.json`, and `aett update` moves the pins. Some tools come by name from their GitHub releases, such as `vite-plus`; `release({ github, asset, bin })` adds another. To choose the source yourself, take the package from its registry: `nixpkgs.git`, `unstable["zed-editor"]`, `llmAgents["claude-code"]`, `cask.raycast`, `brew.mas`. The registries are there in `fleet.ts` without an import, and your editor completes every name in them: aett writes the names of the pinned Nix inputs and Homebrew's catalog into `.aett/packages.d.ts` on `create` and `update`. Homebrew's packages reach only Macs and come unpinned.

Dotfiles follow the same targets: `dotfiles/default/` goes to every machine with your user, then `dotfiles/<tag>/`, `dotfiles/<service>/` and `dotfiles/<machine>/`. `{{host.name}}`, `{{host.color}}` and `{{home}}` are filled in on each machine.

Every name is typed: machines, tags, services and their settings, and package names once the registries are written. A long part moves to its own file with a plain import.

## Commands

| Command | What it does |
|---|---|
| `aett show` | Prints the fleet by machine: services, endpoints, packages by source, dotfiles. |
| `aett machine install <name>` | Installs a NixOS machine from the aett installer, erasing its disks. One that already runs Linux with Nix switches into the installer itself, without a USB stick: pass `--host` with its address. |
| `aett apply [name]` | Builds each machine's system on it and switches to it. On a Mac, it applies the Mac itself. |
| `aett status` | Asks every machine whether it runs what fleet.ts builds, and how its services are. |
| `aett update [name]` | Moves pins forward. On a Mac in the fleet, it also upgrades its Homebrew packages. |
| `aett machine unlock <name>` | Opens an encrypted machine waiting at boot, over its LAN (reach it over a VPN from elsewhere). |
| `aett machine destroy <name>` | Deletes a VM that fleet.ts dropped. You remove its node in the Tailscale admin console. |
| `aett secret set <name>` | Sets a secret machines read. |
| `aett tailscale setup` | Says what your tailnet's policy needs, or keeps the OAuth client that adds it. |

## Services

A web endpoint is served by Caddy with the machine's ts.net certificate, at `https://<machine>.<tailnet>.ts.net:<port>`. It needs MagicDNS and HTTPS Certificates turned on under DNS in the Tailscale admin console. Your tailnet's policy decides who reaches it; aett adds or shows the grants the fleet's machines need.

`backup: { server: "<machine>" }` makes that machine the Kopia repository server. Every other machine with your user or service state backs up its home and that state to it hourly. A built-in ignore list and `.kopiaignore` files leave things out. Restore is manual: `kopia` is on every machine.

## Your own services

A service of your own is a folder, `services/<name>/`, with `nixos.nix`, `darwin.nix` and `dotfiles/` as it needs, and a `service.ts` when it has settings or more:

```ts
import { Schema, service } from "aett"

export default service({
	options: Schema.Struct({ greeting: Schema.optionalKey(Schema.String) }),
	endpoints: { page: { port: 8080, web: true } },
	health: "curl -fsS http://127.0.0.1:8080 >/dev/null && echo serving",
})
```

aett finds the folder by itself and writes its name and settings into `.aett/services.d.ts`, so `services: { hello: "zeus" }` is checked like aett's own. Its modules read `config.aett.services.hello`: whether this machine is an instance, its settings there, and every peer with its tailnet address. A service can declare generated or prompted secrets, state (bulk state lands on a NAS's tank), a package, and clients.

## License

MIT
