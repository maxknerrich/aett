import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { applyTargets } from "../src/domain/apply.ts";
import type { State } from "../src/domain/state.ts";
import { fleet, machine } from "../src/index.ts";

const declared = fleet({
	machines: [
		machine("box", { role: "hypervisor" }),
		machine("fresh", { role: "server" }),
		machine("web", { role: "server" }),
	],
});

const disk = "/dev/disk/by-id/nvme-test";

const state: State = {
	operator: {
		sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKey operator@mac"],
		age: "age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d",
	},
	machines: new Map([
		["box", { facts: true, disk, installed: true }],
		["fresh", { facts: true, disk }],
		["web", { facts: true, disk, installed: true }],
	]),
};

describe("applyTargets", () => {
	it("covers every installed machine and skips the rest", () => {
		expect(applyTargets(declared, state, Option.none())).toEqual(
			Result.succeed({ targets: ["box", "web"], skipped: ["fresh"] }),
		);
	});

	it("limits the run to a named machine", () => {
		expect(applyTargets(declared, state, Option.some("web"))).toEqual(
			Result.succeed({ targets: ["web"], skipped: [] }),
		);
	});

	it("rejects a named machine that is not installed", () => {
		expect(applyTargets(declared, state, Option.some("fresh"))).toEqual(
			Result.fail("fresh is not installed yet. Install it with aett machine install fresh."),
		);
	});

	it("rejects a name fleet.ts does not declare", () => {
		expect(applyTargets(declared, state, Option.some("gone"))).toEqual(
			Result.fail('fleet.ts declares no machine named "gone".'),
		);
	});
});
