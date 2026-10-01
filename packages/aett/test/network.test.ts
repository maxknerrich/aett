import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { allocate, guestInterface } from "../src/domain/network.ts";
import type { MachineState, State } from "../src/domain/state.ts";
import { fleet, hypervisor, server } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

const operator = {
	sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKey operator@mac"],
	ageKeys: ["age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d"],
} as const;

const stateWith = (machines: ReadonlyArray<readonly [string, MachineState]>): State => ({
	operator,
	machines: new Map(machines),
});

const declared = loaded(
	fleet({
		machines: {
			kronos: hypervisor(),
			nas: server(),
			zeus: server({ host: "kronos" }),
			hades: server({ host: "kronos" }),
			web: server({ host: "nas" }),
		},
	}),
);

describe("allocate", () => {
	it("gives each host a subnet and each VM the next free address on it, keeping what state records", () => {
		const state = stateWith([
			["kronos", { facts: true, subnet: "10.100.1.0/24" }],
			["hades", { facts: false, host: "kronos", address: "10.100.1.2" }],
			// Removed from fleet.ts but not destroyed: its address stays taken.
			["old", { facts: false, host: "kronos", address: "10.100.1.3" }],
		]);

		expect(allocate(declared, state)).toEqual(
			Result.succeed(
				new Map([
					["nas", { subnet: "10.100.2.0/24" }],
					["web", { host: "nas", address: "10.100.2.2" }],
					["zeus", { host: "kronos", address: "10.100.1.4" }],
				]),
			),
		);
	});

	it("changes nothing once everything is recorded", () => {
		const state = stateWith([
			["kronos", { facts: true, subnet: "10.100.1.0/24" }],
			["nas", { facts: true, subnet: "10.100.2.0/24" }],
			["zeus", { facts: false, host: "kronos", address: "10.100.1.2" }],
			["hades", { facts: false, host: "kronos", address: "10.100.1.3" }],
			["web", { facts: false, host: "nas", address: "10.100.2.2" }],
		]);

		expect(allocate(declared, state)).toEqual(Result.succeed(new Map()));
	});

	it("refuses to move a VM to another host", () => {
		const state = stateWith([["web", { facts: false, host: "kronos", address: "10.100.1.2" }]]);

		expect(allocate(declared, state)).toEqual(
			Result.fail(
				"web runs on kronos, but fleet.ts now puts it on nas. aett can't move a VM yet: remove it from fleet.ts, apply kronos, run aett machine destroy web, then declare it on nas.",
			),
		);
	});
});

describe("guestInterface", () => {
	it("derives the gateway, MAC and tap device from the address", () => {
		expect(guestInterface("10.100.3.17")).toEqual(
			Option.some({
				address: "10.100.3.17",
				prefixLength: 24,
				gateway: "10.100.3.1",
				mac: "02:00:0a:64:03:11",
				tap: "vm-17",
			}),
		);
	});
});
