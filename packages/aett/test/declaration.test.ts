import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { computer, fleet, hypervisor, server } from "../src/index.ts";

// What decodeFleet reports for a declaration it has to reject.
const problems = (declaration: Declaration) =>
	Result.getOrThrow(Result.flip(decodeFleet(declaration)));

describe("decodeFleet", () => {
	it("turns machines and stacks into the machines aett works with", () => {
		const tools = { packages: ["git", "gh"] };

		const declared = fleet({
			machines: {
				kronos: hypervisor({ system: { encrypted: true } }),
				astraeus: server({ system: { channel: "unstable" } }),
				hades: server({ host: "kronos", system: { memory: "8 GiB" } }),
				fawkes: computer({ os: "macos" }),
			},
			stacks: {
				shell: { packages: ["fish"] },
				dev: { machines: { astraeus: tools, fawkes: { ...tools, apps: ["ghostty"] } } },
			},
		});

		expect(Result.getOrThrow(decodeFleet(declared)).machines).toEqual([
			{
				name: "kronos",
				role: "hypervisor",
				encrypted: true,
				channel: "stable",
				packages: [],
				unsupported: [],
			},
			{
				name: "astraeus",
				role: "server",
				encrypted: false,
				channel: "unstable",
				packages: ["fish", "git", "gh"],
				unsupported: [],
			},
			{
				name: "hades",
				role: "server",
				encrypted: false,
				channel: "stable",
				packages: ["fish"],
				unsupported: ["VMs"],
			},
			{
				name: "fawkes",
				role: "computer",
				encrypted: false,
				channel: "stable",
				packages: ["fish", "git", "gh"],
				unsupported: ["Macs", "apps"],
			},
		]);
	});

	it("rejects a VM whose host can't run VMs", () => {
		const declared = fleet({
			machines: {
				mac: computer({ os: "macos" }),
				// @ts-expect-error a VM runs on a hypervisor or a bare-metal server
				vm: server({ host: "mac" }),
			},
		});

		expect(problems(declared)).toBe(
			"machines.vm.host: mac is a computer; a VM runs on a hypervisor or a bare-metal server",
		);
	});

	it("rejects a host on anything but a server", () => {
		// @ts-expect-error only a server can be a VM
		const declared = fleet({ machines: { box: hypervisor({ host: "box" }) } });

		expect(problems(declared)).toBe(
			"machines.box.host: Only a server can be a VM; a hypervisor runs on bare metal",
		);
	});

	it("rejects settings that don't fit the machine", () => {
		const bareMetal = fleet({
			machines: {
				// @ts-expect-error memory is for VMs
				box: server({ system: { memory: "8 GiB" } }),
			},
		});

		const mac = fleet({
			machines: {
				// @ts-expect-error a Mac has no disk settings
				mac: computer({ os: "macos", system: { encrypted: true } }),
			},
		});

		const small = fleet({
			machines: { host: hypervisor(), vm: server({ host: "host", system: { memory: "1 GiB" } }) },
		});

		expect(problems(bareMetal)).toContain("machines.box.system.memory: Unexpected key");
		expect(problems(mac)).toContain("machines.mac.system.encrypted: Expected never");
		expect(problems(small)).toContain("machines.vm.system.memory: Expected at least 2 GiB");
	});

	it("keeps stacks off hypervisors and fits what they bring to each machine", () => {
		const machines = { kronos: hypervisor(), nas: server(), laptop: computer() };

		const onHypervisor = fleet({
			machines,
			stacks: {
				// @ts-expect-error stacks never reach hypervisors
				a: { machines: { kronos: { packages: ["git"] } } },
			},
		});

		const appsOnServer = fleet({
			machines,
			stacks: {
				// @ts-expect-error apps need a computer
				a: { machines: { nas: { apps: ["firefox"] } } },
			},
		});

		const homeOnComputer = fleet({
			machines,
			stacks: {
				// @ts-expect-error a computer always has a home
				a: { machines: { laptop: { home: true } } },
			},
		});

		const unknown = fleet({
			machines,
			stacks: {
				// @ts-expect-error a stack names only declared machines
				a: { machines: { nope: { packages: ["git"] } } },
			},
		});

		expect(problems(onHypervisor)).toBe(
			"stacks.a.machines.kronos: kronos is a hypervisor; stacks never reach hypervisors",
		);
		expect(problems(appsOnServer)).toBe(
			"stacks.a.machines.nas.apps: nas is a server; apps need a computer",
		);
		expect(problems(homeOnComputer)).toBe(
			"stacks.a.machines.laptop.home: laptop is a computer, which always has a home",
		);
		expect(problems(unknown)).toBe('stacks.a.machines.nope: There is no machine named "nope"');
	});

	it("rejects a machine name that isn't a hostname and keys fleet() doesn't know", () => {
		expect(problems(fleet({ machines: { Box: server() } }))).toContain(
			"machines.Box: Expected a lowercase hostname label",
		);

		// @ts-expect-error fleet() takes machines and stacks
		expect(problems(fleet({ machines: {}, extra: true }))).toContain(
			"fleet().extra: Unexpected key",
		);
	});
});
