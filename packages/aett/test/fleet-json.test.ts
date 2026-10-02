import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import type { Operator, State } from "../src/domain/state.ts";
import { fleetJson } from "../src/engine/nix/fleet-json.ts";
import { computer, fleet, hypervisor, server } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

const sshKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKey operator@mac";

const operator: Operator = {
	sshKeys: [sshKey],
	ageKeys: ["age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d"],
};

const disk = "/dev/disk/by-id/nvme-test";

describe("fleetJson", () => {
	it("lists only machines with facts and a disk recorded, and nothing aett can't build yet", () => {
		const declared = loaded(
			fleet({
				machines: {
					box: hypervisor(),
					fresh: server(),
					discovered: server(),
					factless: computer(),
					vm: server({ host: "box" }),
				},
			}),
		);

		const state: State = {
			operator,
			machines: new Map([
				["box", { facts: true, disk }],
				["fresh", { facts: false }],
				["discovered", { facts: true }],
				["factless", { facts: false, disk }],
				["vm", { facts: true, disk }],
			]),
		};

		expect(Object.keys(fleetJson(declared, state, []).machines)).toEqual(["box"]);
	});

	it("emits each machine's settings, the packages its stacks bring and Tailscale, with the operator's keys", () => {
		const declared = loaded(
			fleet({
				machines: {
					box: hypervisor(),
					web: server({ system: { channel: "unstable", encrypted: true } }),
				},
				stacks: {
					tools: { packages: ["htop"] },
					private: { machines: { web: { services: { tailscale: false } } } },
				},
			}),
		);

		const state: State = {
			operator,
			machines: new Map([
				["box", { facts: true, disk }],
				["web", { facts: true, disk, installed: true }],
			]),
		};

		expect(fleetJson(declared, state, ["tailscale/auth-key"])).toEqual({
			operator: { sshKeys: [sshKey] },
			machines: {
				box: {
					role: "hypervisor",
					channel: "stable",
					packages: [],
					tailscale: { tag: "tag:hypervisor", authKey: true },
					user: null,
					disk: { device: disk, encrypted: false },
				},
				web: {
					role: "server",
					channel: "unstable",
					packages: ["htop"],
					tailscale: null,
					user: null,
					disk: { device: disk, encrypted: true },
				},
			},
		});
	});

	it("lists a VM with its interface once its host is listed, and names it on the host", () => {
		const declared = loaded(
			fleet({
				machines: {
					box: hypervisor(),
					fresh: hypervisor(),
					vm: server({ host: "box", system: { cpu: 4, memory: "8 GiB" } }),
					waiting: server({ host: "fresh" }),
				},
			}),
		);

		const state: State = {
			operator,
			machines: new Map([
				["box", { facts: true, disk, subnet: "10.100.1.0/24" }],
				["fresh", { facts: false, subnet: "10.100.2.0/24" }],
				["vm", { facts: false, host: "box", address: "10.100.1.2" }],
				["waiting", { facts: false, host: "fresh", address: "10.100.2.2" }],
			]),
		};

		expect(fleetJson(declared, state, []).machines).toEqual({
			box: {
				role: "hypervisor",
				channel: "stable",
				packages: [],
				tailscale: { tag: "tag:hypervisor", authKey: false },
				user: null,
				disk: { device: disk, encrypted: false },
				guests: ["vm"],
				network: { address: "10.100.1.1", prefixLength: 24 },
				forwards: [],
			},
			vm: {
				role: "server",
				channel: "stable",
				packages: [],
				tailscale: { tag: "tag:server", authKey: false },
				user: null,
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
					forwards: null,
				},
			},
		});
	});
});
