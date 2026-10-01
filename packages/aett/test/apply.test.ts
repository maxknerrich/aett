import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { applyTargets } from "../src/domain/apply.ts";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import type { State } from "../src/domain/state.ts";
import { fleet, hypervisor, server } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

const declared = loaded(
	fleet({
		machines: {
			box: hypervisor(),
			fresh: server(),
			web: server(),
			vm: server({ host: "box" }),
		},
	}),
);

const disk = "/dev/disk/by-id/nvme-test";

const state: State = {
	operator: {
		sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKey operator@mac"],
		ageKeys: ["age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d"],
	},
	machines: new Map([
		["box", { facts: true, disk, installed: true }],
		["fresh", { facts: true, disk }],
		["web", { facts: true, disk, installed: true }],
		["vm", { facts: false }],
	]),
};

describe("applyTargets", () => {
	it("covers every installed machine and skips the rest, saying why", () => {
		expect(applyTargets(declared, state, Option.none())).toEqual(
			Result.succeed({
				targets: ["box", "web"],
				skipped: [
					{ name: "fresh", reason: "is not installed yet" },
					{ name: "vm", reason: "uses what aett can't build yet: VMs" },
				],
			}),
		);
	});

	it("limits the run to a named machine", () => {
		expect(applyTargets(declared, state, Option.some("web"))).toEqual(
			Result.succeed({ targets: ["web"], skipped: [] }),
		);
	});

	it("rejects a named machine that is not installed or that aett can't build yet", () => {
		expect(applyTargets(declared, state, Option.some("fresh"))).toEqual(
			Result.fail("fresh is not installed yet. Install it with aett machine install fresh."),
		);
		expect(applyTargets(declared, state, Option.some("vm"))).toEqual(
			Result.fail("vm uses what aett can't build yet: VMs."),
		);
	});

	it("rejects a machine whose declared disk encryption differs from its install", () => {
		const encrypted = loaded(
			fleet({ machines: { box: hypervisor({ system: { encrypted: true } }) } }),
		);

		expect(applyTargets(encrypted, state, Option.none())).toEqual(
			Result.fail(
				"box's disk was installed unencrypted, but fleet.ts now declares it encrypted. Only a reinstall changes that: aett machine install box --reinstall.",
			),
		);
	});

	it("rejects a name fleet.ts does not declare", () => {
		expect(applyTargets(declared, state, Option.some("gone"))).toEqual(
			Result.fail('fleet.ts declares no machine named "gone".'),
		);
	});
});
