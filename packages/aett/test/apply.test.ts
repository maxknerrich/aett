import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { applyTargets } from "../src/domain/apply.ts";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import type { State } from "../src/domain/state.ts";
import { computer, fleet, hypervisor, server } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

const declared = loaded(
	fleet({
		user: "mkn",
		machines: {
			box: hypervisor(),
			fresh: server(),
			web: server(),
			vm: server({ host: "box" }),
			waiting: server({ host: "fresh" }),
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
		["vm", { facts: false, host: "box", address: "10.100.1.2" }],
		["waiting", { facts: false, host: "fresh", address: "10.100.2.2" }],
	]),
};

describe("applyTargets", () => {
	it("covers every installed machine and its VMs, hosts first, and skips the rest, saying why", () => {
		expect(applyTargets(declared, state, Option.none(), Option.none())).toEqual(
			Result.succeed({
				targets: ["box", "web", "vm"],
				skipped: [
					{ name: "fresh", reason: "is not installed yet" },
					{ name: "waiting", reason: "runs on fresh, which aett can't apply yet" },
				],
			}),
		);
	});

	it("limits the run to a named machine", () => {
		expect(applyTargets(declared, state, Option.some("web"), Option.none())).toEqual(
			Result.succeed({ targets: ["web"], skipped: [] }),
		);
	});

	it("rejects a named machine that is not installed, or a VM whose host isn't", () => {
		expect(applyTargets(declared, state, Option.some("fresh"), Option.none())).toEqual(
			Result.fail("fresh is not installed yet. Install it with aett machine install fresh."),
		);
		expect(applyTargets(declared, state, Option.some("waiting"), Option.none())).toEqual(
			Result.fail("waiting runs on fresh, which aett can't apply yet. Apply fresh first."),
		);
	});

	it("rejects a machine whose declared disks differ from its install", () => {
		const encrypted = loaded(
			fleet({ machines: { box: hypervisor({ system: { encrypted: true } }) } }),
		);

		expect(applyTargets(encrypted, state, Option.none(), Option.none())).toEqual(
			Result.fail(
				"box's disk was installed unencrypted, but fleet.ts now declares it encrypted. Only a reinstall changes that: aett machine install box --reinstall.",
			),
		);

		const pools = { root: [disk, `${disk}-2`], tank: [`${disk}-3`, `${disk}-4`] };

		const wasNas = {
			...state,
			machines: new Map([["box", { facts: true, pools, encrypted: true, installed: true }]]),
		};

		expect(applyTargets(encrypted, wasNas, Option.none(), Option.none())).toEqual(
			Result.fail(
				"box was installed as a NAS, on pools, but fleet.ts now declares it a hypervisor, on one disk. Only a reinstall changes that: aett machine install box --reinstall.",
			),
		);
	});

	it("applies a Mac only on the Mac itself, after every other machine", () => {
		const withMac = loaded(
			fleet({ user: "mkn", machines: { web: server(), fawkes: computer({ os: "macos" }) } }),
		);

		expect(applyTargets(withMac, state, Option.none(), Option.none())).toEqual(
			Result.succeed({
				targets: ["web"],
				skipped: [{ name: "fawkes", reason: "is a Mac, which applies to itself" }],
			}),
		);
		expect(applyTargets(withMac, state, Option.none(), Option.some("fawkes"))).toEqual(
			Result.succeed({ targets: ["web", "fawkes"], skipped: [] }),
		);
		expect(applyTargets(withMac, state, Option.some("fawkes"), Option.none())).toEqual(
			Result.fail("fawkes is a Mac. Run aett apply on it."),
		);
	});

	it("rejects a name fleet.ts does not declare", () => {
		expect(applyTargets(declared, state, Option.some("gone"), Option.none())).toEqual(
			Result.fail('fleet.ts declares no machine named "gone".'),
		);
	});
});
