import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { allocate, guestInterface, sshConfig } from "../src/domain/network.ts";
import type { MachineState, State } from "../src/domain/state.ts";
import { fleet, hypervisor, server, vm } from "../src/index.ts";

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
		user: "mkn",
		machines: {
			kronos: hypervisor(),
			nas: server(),
			zeus: vm({ host: "kronos" }),
			hades: vm({ host: "kronos" }),
			web: vm({ host: "nas" }),
		},
	}),
);

describe("allocate", () => {
	it("gives each host a subnet and each VM the next free address on it and its forwards, keeping what state records", () => {
		const state = stateWith([
			["kronos", { facts: true, subnet: "10.100.1.0/24" }],
			[
				"hades",
				{
					facts: false,
					host: "kronos",
					address: "10.100.1.2",
					forwards: { ssh: 2202, mosh: [61010, 61019] },
				},
			],
			// Removed from fleet.ts but not destroyed: its address stays taken.
			["old", { facts: false, host: "kronos", address: "10.100.1.3" }],
		]);

		expect(allocate(declared, state)).toEqual(
			Result.succeed(
				new Map([
					["nas", { subnet: "10.100.2.0/24" }],
					[
						"web",
						{ host: "nas", address: "10.100.2.2", forwards: { ssh: 2202, mosh: [61010, 61019] } },
					],
					[
						"zeus",
						{
							host: "kronos",
							address: "10.100.1.4",
							forwards: { ssh: 2204, mosh: [61030, 61039] },
						},
					],
				]),
			),
		);
	});

	it("changes nothing once everything is recorded", () => {
		const state = stateWith([
			["kronos", { facts: true, subnet: "10.100.1.0/24" }],
			["nas", { facts: true, subnet: "10.100.2.0/24" }],
			[
				"zeus",
				{
					facts: false,
					host: "kronos",
					address: "10.100.1.2",
					forwards: { ssh: 2202, mosh: [61010, 61019] },
				},
			],
			[
				"hades",
				{
					facts: false,
					host: "kronos",
					address: "10.100.1.3",
					forwards: { ssh: 2203, mosh: [61020, 61029] },
				},
			],
			[
				"web",
				{
					facts: false,
					host: "nas",
					address: "10.100.2.2",
					forwards: { ssh: 2202, mosh: [61010, 61019] },
				},
			],
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

describe("sshConfig", () => {
	it("logs in as the user at each machine's tailnet name, or through its host's forward before it joined", () => {
		const state = stateWith([
			[
				"zeus",
				{
					facts: false,
					host: "kronos",
					address: "10.100.1.2",
					tailnet: "100.64.0.7",
					tailnetName: "zeus.example.ts.net",
				},
			],
			[
				"hades",
				{
					facts: false,
					host: "kronos",
					address: "10.100.1.3",
					forwards: { ssh: 2203, mosh: [61020, 61029] },
				},
			],
		]);

		expect(sshConfig(declared, state, "/fleet/state/known_hosts")).toBe(
			[
				"# Written by aett: the fleet's machines, over the tailnet. Include it from ~/.ssh/config.",
				"",
				"Host zeus",
				"\tHostName 100.64.0.7",
				"\tUser mkn",
				"\tHostKeyAlias zeus",
				'\tUserKnownHostsFile "/fleet/state/known_hosts"',
				"",
				"Host hades",
				"\tHostName kronos.local",
				"\tPort 2203",
				"\tAddressFamily inet",
				"\tUser mkn",
				"\tHostKeyAlias hades",
				'\tUserKnownHostsFile "/fleet/state/known_hosts"',
				"",
			].join("\n"),
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
