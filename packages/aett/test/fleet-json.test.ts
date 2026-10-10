import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import type { Pins } from "../src/domain/pins.ts";
import type { Operator, State } from "../src/domain/state.ts";
import { fleetJson } from "../src/engine/nix/fleet-json.ts";
import { computer, fleet, hypervisor, mac, nas, server, vm } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

const sshKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKey operator@mac";

const operator: Operator = {
	sshKeys: [sshKey],
	ageKeys: ["age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d"],
};

const disk = "/dev/disk/by-id/nvme-test";

const pins: Pins = {
	inputs: { nodes: { root: {} }, root: "root", version: 7 },
	releases: {},
	packages: {
		git: { linux: "nixpkgs", darwin: "nixpkgs" },
		"claude-code": { linux: "llm-agents" },
		kopia: { linux: "nixpkgs", darwin: "nixpkgs" },
		tailscale: { linux: "nixpkgs", darwin: "nixpkgs" },
		ghostty: { linux: "nixpkgs", darwin: "cask" },
	},
};

const none = { secrets: [], fingerprints: new Map<string, string>() };

describe("fleetJson", () => {
	it("lists only machines with facts and disks recorded, Macs aett applied, and nothing it can't build", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					box: hypervisor(),
					fresh: server(),
					discovered: server(),
					vault: nas(),
					fawkes: mac(),
					desk: computer({ desktop: "gnome" }),
				},
			}),
		);

		const state: State = {
			operator,
			machines: new Map([
				["box", { facts: true, disk }],
				["fresh", { facts: false }],
				["discovered", { facts: true }],
				["vault", { facts: true, pools: { root: [disk, `${disk}2`], tank: [] } }],
				["fawkes", { facts: false, system: "aarch64-darwin" }],
				["desk", { facts: true, disk }],
			]),
		};

		expect(Object.keys(fleetJson(declared, state, none, pins).machines)).toEqual([
			"box",
			"vault",
			"fawkes",
		]);
	});

	it("emits each machine's packages by source, the secrets it reads and its services with their peers", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					box: hypervisor({ encrypted: true }),
					web: server({ channel: "unstable" }),
				},
				services: { backup: { server: "web" } },
				packages: { default: ["git", "claude-code", "htop"] },
			}),
		);

		const state: State = {
			operator,
			machines: new Map([
				[
					"box",
					{
						facts: true,
						disk,
						unlock: { address: "192.168.1.9" },
					},
				],
				["web", { facts: true, disk, tailnet: "100.64.0.2", tailnetName: "web.example.ts.net" }],
			]),
		};

		const emitted = fleetJson(
			declared,
			state,
			{
				secrets: ["users/mkn", "backup/repository/web", "backup/tls/web"],
				fingerprints: new Map([["backup/tls/web", "ab12"]]),
			},
			pins,
		);

		expect(emitted.machines["box"]).toMatchObject({
			role: "hypervisor",
			user: null,
			secrets: [],
			disk: { device: disk, encrypted: true },
			unlock: true,
		});

		expect(emitted.machines["web"]).toMatchObject({
			channel: "unstable",
			// htop has no source pinned yet, so it waits.
			packages: {
				"llm-agents": ["claude-code"],
				nixpkgs: ["git", "kopia", "tailscale"],
				unstable: [],
			},
			user: { name: "mkn", password: true },
			tailnet: { address: "100.64.0.2", name: "web.example.ts.net" },
			secrets: [
				{ name: "users/mkn", file: "secrets/users/mkn.json" },
				{ name: "backup/repository/web", file: "secrets/services/backup/repository/web.json" },
				{ name: "backup/tls/web", file: "secrets/services/backup/tls/web.json" },
			],
			services: {
				backup: {
					instance: true,
					options: {},
					peers: [
						{
							name: "web",
							instance: true,
							tailnet: { address: "100.64.0.2", name: "web.example.ts.net" },
							fingerprints: { tls: "ab12" },
						},
					],
				},
			},
			state: [{ path: "/var/lib/aett-backup", bulk: true }],
			endpoints: [{ service: "backup", name: "repository", port: 51515, web: false }],
			disk: { device: disk, encrypted: false },
			unlock: false,
		});
	});

	it("gives a NAS its pools and a Mac its platform, its Homebrew packages and whether apply may zap", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: { vault: nas(), fawkes: mac() },
				packages: { fawkes: ["ghostty", "git", "brew.mas"] },
			}),
		);

		const pools = { root: ["/dev/a", "/dev/b"], tank: ["/dev/c", "/dev/d"] };

		const state: State = {
			operator,
			machines: new Map([
				["vault", { facts: true, pools }],
				["fawkes", { facts: false, system: "aarch64-darwin", zap: true }],
			]),
		};

		const { machines } = fleetJson(declared, state, none, pins);

		expect(machines["vault"]).toMatchObject({ role: "nas", pools, unlock: false });
		expect(machines["fawkes"]).toMatchObject({
			packages: { nixpkgs: ["git", "tailscale"] },
			darwin: { system: "aarch64-darwin" },
			homebrew: { zap: true, casks: ["ghostty"], brews: ["mas"] },
		});
	});

	it("lists a VM with its interface once its host is listed, and names it on the host", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					box: hypervisor(),
					fresh: hypervisor(),
					vm: vm({ host: "box", cpu: 4, memory: 8 }),
					waiting: vm({ host: "fresh" }),
				},
			}),
		);

		const state: State = {
			operator,
			machines: new Map([
				["box", { facts: true, disk, subnet: "10.100.1.0/24" }],
				["fresh", { facts: false, subnet: "10.100.2.0/24" }],
				[
					"vm",
					{
						facts: false,
						host: "box",
						address: "10.100.1.2",
						forwards: { ssh: 2202, mosh: [61010, 61019] },
					},
				],
				["waiting", { facts: false, host: "fresh", address: "10.100.2.2" }],
			]),
		};

		const { machines } = fleetJson(declared, state, none, pins);

		expect(Object.keys(machines)).toEqual(["box", "vm"]);
		expect(machines["box"]).toMatchObject({
			guests: ["vm"],
			network: { address: "10.100.1.1", prefixLength: 24 },
			forwards: [{ address: "10.100.1.2", ssh: 2202, mosh: { from: 61010, to: 61019 } }],
		});
		expect(machines["vm"]).toMatchObject({
			vm: {
				host: "box",
				cpu: 4,
				memory: 8192,
				disk: 20480,
				address: "10.100.1.2",
				prefixLength: 24,
				gateway: "10.100.1.1",
				mac: "02:00:0a:64:01:02",
				tap: "vm-2",
				forwards: { ssh: 2202, mosh: { from: 61010, to: 61019 } },
			},
		});
	});
});
