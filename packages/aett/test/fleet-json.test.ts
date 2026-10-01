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

		expect(Object.keys(fleetJson(declared, state).machines)).toEqual(["box"]);
	});

	it("emits each machine's settings and the packages its stacks bring, with the operator's keys", () => {
		const declared = loaded(
			fleet({
				machines: {
					box: hypervisor(),
					web: server({ system: { channel: "unstable", encrypted: true } }),
				},
				stacks: { tools: { packages: ["htop"] } },
			}),
		);

		const state: State = {
			operator,
			machines: new Map([
				["box", { facts: true, disk }],
				["web", { facts: true, disk, installed: true }],
			]),
		};

		expect(fleetJson(declared, state)).toEqual({
			operator: { sshKeys: [sshKey] },
			machines: {
				box: {
					role: "hypervisor",
					channel: "stable",
					packages: [],
					disk: { device: disk, encrypted: false },
				},
				web: {
					role: "server",
					channel: "unstable",
					packages: ["htop"],
					disk: { device: disk, encrypted: true },
				},
			},
		});
	});
});
