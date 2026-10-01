import { Option, Result } from "effect";
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
				kind: "nixos",
				encrypted: true,
				channel: "stable",
				vm: Option.none(),
				tailscale: true,
				packages: [],
				unstable: [],
				fast: [],
				releases: [],
				home: [],
				unsupported: [],
			},
			{
				name: "astraeus",
				role: "server",
				kind: "nixos",
				encrypted: false,
				channel: "unstable",
				vm: Option.none(),
				tailscale: true,
				packages: ["fish", "gh", "git"],
				unstable: [],
				fast: [],
				releases: [],
				home: [],
				unsupported: [],
			},
			{
				name: "hades",
				role: "server",
				kind: "vm",
				encrypted: false,
				channel: "stable",
				vm: Option.some({ host: "kronos", cpu: 2, memory: 8192, disk: 20480 }),
				tailscale: true,
				packages: ["fish"],
				unstable: [],
				fast: [],
				releases: [],
				home: [],
				unsupported: [],
			},
			{
				name: "fawkes",
				role: "computer",
				kind: "macos",
				encrypted: false,
				channel: "stable",
				vm: Option.none(),
				tailscale: true,
				packages: ["fish", "gh", "git"],
				unstable: [],
				fast: [],
				releases: [],
				home: [],
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

		const mixed = fleet({
			machines: {
				// @ts-expect-error memory is for VMs, even next to bare-metal settings
				box: server({ system: { memory: "8 GiB", encrypted: true } }),
				// @ts-expect-error a VM's disk isn't encrypted
				vm: server({ host: "box", system: { encrypted: true, channel: "stable" } }),
			},
		});

		const unknownKeys = fleet({
			machines: {
				// @ts-expect-error system has no such setting
				box: server({ system: { encrypted: true, typo: true } }),
				// @ts-expect-error packages belong in a stack
				nas: server({ system: { encrypted: true }, packages: ["git"] }),
			},
		});

		const renamed = fleet({
			machines: {
				// @ts-expect-error the role function sets the role
				box: server({ role: "computer", system: { encrypted: true } }),
			},
		});

		const inline = fleet({
			machines: {
				// @ts-expect-error a machine written out by hand gets the same checks
				box: { ...server(), system: { memory: "8 GiB" } },
				// @ts-expect-error unknown keys too
				nas: { ...server(), packages: ["git"] },
			},
		});

		const small = fleet({
			machines: { host: hypervisor(), vm: server({ host: "host", system: { memory: "256 MiB" } }) },
		});

		expect(problems(bareMetal)).toContain("machines.box.system.memory: Unexpected key");
		expect(problems(mac)).toContain("machines.mac.system.encrypted: Expected never");
		expect(problems(small)).toContain("machines.vm.system.memory: Expected at least 512 MiB");
		expect(problems(mixed)).toContain("machines.box.system.memory: Unexpected key");
		expect(problems(unknownKeys)).toContain("machines.box.system.typo: Unexpected key");
		expect(problems(unknownKeys)).toContain("machines.nas.packages: Unexpected key");
		expect(Result.getOrThrow(decodeFleet(renamed)).machines[0]?.role).toBe("server");
		expect(problems(inline)).toContain("machines.box.system.memory: Unexpected key");
		expect(problems(inline)).toContain("machines.nas.packages: Unexpected key");
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

		const onlyHypervisors = fleet({
			machines: { box: hypervisor() },
			stacks: {
				// @ts-expect-error with only hypervisors, a stack has no machine to name
				a: { machines: { box: { packages: ["git"] } } },
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
		expect(problems(unknown)).toBe('stacks.a.machines.nope: There is no machine named "nope"');
		expect(problems(onlyHypervisors)).toBe(
			"stacks.a.machines.box: box is a hypervisor; stacks never reach hypervisors",
		);
	});

	it("requires the fleet's user once a stack gives a machine a home", () => {
		expect(
			problems(fleet({ machines: { nas: server() }, stacks: { a: { home: ["shell"] } } })),
		).toBe(
			'fleet(): user is required, because a stack gives nas a home. Name the fleet\'s user, such as user: "you".',
		);
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
