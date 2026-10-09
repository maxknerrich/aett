# aett

Declare a fleet of NixOS servers, VMs, a NAS and Macs in one small TypeScript file. aett installs them, keeps them on what the file says, backs them up and reaches every one over your tailnet. Nix does the work underneath; you don't write any.

```ts
import { computer, fleet, hypervisor, nas, release, server } from "aett"

export default fleet({
	user: "you",
	machines: {
		kronos: hypervisor({ system: { encrypted: true } }),
		zeus: server({ host: "kronos", system: { cpu: 4, memory: "8 GiB" } }),
		vault: nas(),
		mac: computer({ os: "macos" }),
	},
	services: {
		backup: "vault",
		dev: { on: ["zeus", "mac"], packages: ["git", "claude-code"] },
		omintosh: "mac",
		mac: { on: "mac", packages: ["ghostty", "raycast"] },
	},
})
```

## Start

You need Node 24.11 or newer, Nix, and a [Tailscale](https://tailscale.com) tailnet with the Tailscale app on your Mac.

```sh
npm create aett            # or: pnpm create aett, vp create aett
cd <fleet>
aett tailscale setup       # once: whether aett keeps your tailnet's policy for you
```

Each NixOS machine joins the tailnet once, when aett installs it or a VM first starts: aett opens a login page in your browser and you approve it. It joins tagged with its role, such as `tag:server`. Your tailnet's policy has to list those tags, and grants let the fleet's machines reach each other's services. Give `aett tailscale setup` an OAuth client with Policy File: Write and aett adds them itself; without one, it shows you what to add. Macs are your own devices on the Tailscale app.

On a Mac, `create` offers to add the Mac itself and adopts what Homebrew has on it into its `packages`: the casks, and the formulae you installed. It keeps your new age key, which decrypts the fleet's secrets, in the login keychain. It also puts the key on the clipboard so you can save it in your password manager.

## The declaration

`machines` is hardware. Each machine has a role:

| Role | What it is |
|---|---|
| `hypervisor()` | Runs VMs and nothing else. No user, no packages. |
| `nas()` | Storage that runs services and VMs. Two pools, `root` and `tank`, each a btrfs mirror inside LUKS. |
| `server()` | A headless machine, on bare metal or as a VM with `host`. |
| `computer()` | A machine you sit at: NixOS, or a Mac with `os: "macos"`. |

`services` puts things on machines. An entry is the machine it's on, a list of machines, or an object with `on`, `packages` and the service's options. Without `on`, it's on every machine it can be on.

- A name aett ships is that service: `backup` (Kopia), or `omintosh` (a keyboard-first Mac desktop). Tailscale is always on every machine.
- A name from `plugins` is your own service.
- Any other name is a pack of your own: packages and dotfiles.

`packages` takes names and `release({ github, asset, bin })`. The first time aett sees a name, it picks the source. On Linux that's llm-agents.nix, else nixpkgs on the machine's channel, else nixpkgs unstable. On a Mac a Homebrew cask comes first, so apps land in /Applications and update themselves, then those, then a Homebrew formula. aett pins the choice per platform in `state/pins.json`, and `aett update` moves the pins. To choose the source yourself, take the package from its registry: `nixpkgs.git`, `unstable["zed-editor"]`, `llmAgents["claude-code"]`, `cask.raycast`, `brew.mas`. The registries are there in `fleet.ts` without an import, and your editor completes every name in them: aett writes the names of the pinned Nix inputs and Homebrew's catalog into `.aett/packages.d.ts` on `create` and `update`. Plain names complete too. Homebrew's packages reach only Macs and come unpinned.

Dotfiles live in `home/`. `home/default/` goes to every machine with your user, and `home/<entry>/` follows its entry. `{{host.name}}`, `{{host.color}}` and `{{home}}` are filled in on each machine.

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

`backup: "<machine>"` makes that machine the Kopia repository server. Every other machine with your user or service state backs up its home and that state to it hourly. A built-in ignore list and `.kopiaignore` files leave things out. Restore is manual: `kopia` is on every machine.

## Plugins

A plugin is TypeScript metadata plus Nix modules in a directory:

```ts
import { plugin, Schema } from "aett"

export const hello = plugin({
	name: "hello",
	options: Schema.Struct({ greeting: Schema.optionalKey(Schema.String) }),
	directory: new URL(".", import.meta.url), // nixos.nix, darwin.nix and home/
	endpoints: { page: { port: 8080, web: true } },
	health: "curl -fsS http://127.0.0.1:8080 >/dev/null && echo serving",
})
```

Its modules read `config.aett.services.hello`: whether this machine is an instance, the entry's options, and every peer with its tailnet address. A plugin can declare generated or prompted secrets, state (bulk state lands on a NAS's tank), a package, and clients.

## License

MIT
