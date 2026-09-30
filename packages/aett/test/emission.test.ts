import { describe, expect, it } from "vite-plus/test";
import { fleetJson } from "../src/domain/emission.ts";
import type { Operator, State } from "../src/domain/state.ts";
import { fleet, machine } from "../src/index.ts";

const sshKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKey operator@mac";

const operator: Operator = {
	sshKeys: [sshKey],
	age: "age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d",
};

const disk = "/dev/disk/by-id/nvme-test";

describe("fleetJson", () => {
	it("lists only machines with facts and a disk recorded", () => {
		const declared = fleet({
			machines: [
				machine("box", { role: "hypervisor" }),
				machine("fresh", { role: "server" }),
				machine("discovered", { role: "server" }),
				machine("factless", { role: "computer" }),
			],
		});

		const state: State = {
			operator,
			machines: new Map([
				["box", { facts: true, disk }],
				["fresh", { facts: false }],
				["discovered", { facts: true }],
				["factless", { facts: false, disk }],
			]),
		};

		expect(Object.keys(fleetJson(declared, state).machines)).toEqual(["box"]);
	});

	it("defaults channel, packages and encryption and passes the operator's SSH keys through", () => {
		const declared = fleet({
			machines: [
				machine("box", { role: "hypervisor" }),
				machine("web", {
					role: "server",
					packages: ["htop"],
					channel: "unstable",
					disk: { encrypted: true },
				}),
			],
		});

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
