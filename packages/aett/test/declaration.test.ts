import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { computer, fleet, hypervisor, nas, plugin, release, Schema, server } from "../src/index.ts";

// What decodeFleet reports for a declaration it has to reject.
const problems = (declaration: Declaration) =>
	Result.getOrThrow(Result.flip(decodeFleet(declaration)));

// The fleet aett works with for a declaration it accepts.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

const vp = release({ github: "voidzero-dev/vite-plus", asset: "vp-{target}.tar.gz", bin: "vp" });

describe("decodeFleet", () => {
	it("puts entries on the machines they name, packs on every machine but hypervisors without on", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor({ system: { encrypted: true } }),
					zeus: server({ host: "kronos", system: { memory: "8 GiB" } }),
					vault: nas(),
					fawkes: computer({ os: "macos" }),
				},
				services: {
					backup: "kronos",
					tools: { packages: ["git", vp] },
					dev: { on: ["zeus", "fawkes"], packages: ["claude-code"], apps: ["ghostty"] },
				},
			}),
		);

		expect(
			declared.machines.map(({ name, user, packages, releases, apps, services, home }) => ({
				name,
				user,
				packages,
				releases: releases.map(({ bin }) => bin),
				apps,
				services,
				home,
			})),
		).toEqual([
			{
				name: "kronos",
				user: false,
				packages: ["kopia", "tailscale"],
				releases: [],
				apps: [],
				services: [
					{ name: "tailscale", instance: true },
					{ name: "backup", instance: true },
				],
				home: [],
			},
			{
				name: "zeus",
				user: true,
				packages: ["claude-code", "git", "kopia", "tailscale"],
				releases: ["vp"],
				apps: [],
				services: [
					{ name: "tailscale", instance: true },
					{ name: "backup", instance: false },
				],
				home: ["default", "dev", "tools"],
			},
			{
				name: "vault",
				user: true,
				packages: ["git", "kopia", "tailscale"],
				releases: ["vp"],
				apps: [],
				services: [
					{ name: "tailscale", instance: true },
					{ name: "backup", instance: false },
				],
				home: ["default", "tools"],
			},
			{
				name: "fawkes",
				user: true,
				packages: ["claude-code", "git", "kopia", "tailscale"],
				releases: ["vp"],
				apps: ["ghostty"],
				services: [
					{ name: "tailscale", instance: true },
					{ name: "backup", instance: false },
				],
				home: ["default", "dev", "tools"],
			},
		]);

		expect(declared.machines.find(({ name }) => name === "vault")?.encrypted).toBe(true);
		expect(declared.machines.find(({ name }) => name === "zeus")?.vm).toEqual(
			Option.some({ host: "kronos", cpu: 2, memory: 8192, disk: 20480 }),
		);
	});

	it("makes clients of the machines with the user or a service's state, not of bare hypervisors", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor(),
					astraeus: hypervisor(),
					hades: server({ host: "kronos" }),
				},
				services: { backup: "hades" },
			}),
		);

		expect(declared.services.get("backup")?.instances).toEqual(["hades"]);
		expect(declared.services.get("backup")?.clients).toEqual([]);
	});

	it("checks entries against what their name is: a plugin's options, or a pack's keys", () => {
		const whoami = plugin({
			name: "whoami",
			options: Schema.Struct({ greeting: Schema.optionalKey(Schema.String) }),
			roles: ["server"],
			endpoints: { web: { port: 8080, web: true } },
		});

		const machines = { kronos: hypervisor(), web: server(), fawkes: computer({ os: "macos" }) };

		const good = loaded(
			fleet({
				user: "mkn",
				machines,
				plugins: [whoami],
				services: { whoami: { on: "web", greeting: "hi" } },
			}),
		);

		const wrong = fleet({
			user: "mkn",
			machines,
			plugins: [whoami],
			services: {
				// @ts-expect-error whoami's greeting is a string
				whoami: { on: "web", greeting: 1 },
				// @ts-expect-error a pack has no options
				tools: { packages: ["git"], extra: true },
			},
		});

		const misplaced = fleet({
			user: "mkn",
			machines,
			plugins: [whoami],
			services: {
				// @ts-expect-error whoami runs on servers
				whoami: "fawkes",
				// @ts-expect-error packs never reach hypervisors
				tools: ["kronos"],
				// @ts-expect-error backup runs on one machine
				backup: ["web", "kronos"],
			},
		});

		expect(good.services.get("whoami")?.options).toEqual({ greeting: "hi" });
		expect(problems(wrong)).toContain("services.whoami.greeting: Expected string, got 1");
		expect(problems(wrong)).toContain(
			"services.tools.extra: Unexpected key; a pack takes on, packages and apps",
		);
		expect(problems(misplaced)).toContain(
			"services.whoami.on: whoami can't run on fawkes, which is a Mac",
		);
		expect(problems(misplaced)).toContain(
			"services.tools.on: kronos is a hypervisor, which runs nothing but VMs and services",
		);
		expect(problems(misplaced)).toContain("services.backup.on: backup runs on exactly one machine");
	});

	it("rejects entries for machines that don't exist, tailscale, and plugins named like aett's", () => {
		const unknown = fleet({
			user: "mkn",
			machines: { web: server() },
			// @ts-expect-error on names only declared machines
			services: { tools: { on: "nope" } },
		});

		const tailscale = fleet({
			machines: { web: server() },
			user: "mkn",
			// @ts-expect-error tailscale is on every machine
			services: { tailscale: "web" },
		});

		const clash = fleet({
			user: "mkn",
			machines: { web: server() },
			plugins: [plugin({ name: "backup" })],
		});

		const users = plugin({ name: "users", secrets: { mkn: { generate: "password" } } });

		const collision = fleet({
			user: "mkn",
			machines: { web: server() },
			plugins: [users],
			services: { users: "web" },
		});

		const escaping = fleet({
			user: "mkn",
			machines: { web: server() },
			plugins: [
				plugin({ name: "hello", secrets: { "../../users/mkn": { generate: "password" } } }),
			],
		});

		expect(problems(collision)).toBe(
			"services: users/mkn is the name of two secrets; rename the plugin or its secret",
		);
		expect(problems(escaping)).toContain("plugins.0.secrets");
		expect(problems(unknown)).toBe('services.tools.on: There is no machine named "nope"');
		expect(problems(tailscale)).toBe(
			"services.tailscale: tailscale is on every machine already and takes no entry",
		);
		expect(problems(clash)).toBe("plugins.0.name: aett already knows a plugin named backup");
	});

	it("rejects a VM whose host can't run VMs", () => {
		const declared = fleet({
			user: "mkn",
			machines: {
				mac: computer({ os: "macos" }),
				// @ts-expect-error a VM runs on a hypervisor, a NAS or a bare-metal server
				vm: server({ host: "mac" }),
			},
		});

		expect(problems(declared)).toBe(
			"machines.vm.host: mac is a computer; a VM runs on a hypervisor, a NAS or a bare-metal server",
		);
		expect(
			loaded(fleet({ user: "mkn", machines: { vault: nas(), vm: server({ host: "vault" }) } }))
				.machines[1]?.vm,
		).toEqual(Option.some({ host: "vault", cpu: 2, memory: 2048, disk: 20480 }));
	});

	it("rejects settings that don't fit the machine", () => {
		const bareMetal = fleet({
			user: "mkn",
			machines: {
				// @ts-expect-error memory is for VMs
				box: server({ system: { memory: "8 GiB" } }),
				// @ts-expect-error a NAS is always encrypted
				vault: nas({ system: { encrypted: true } }),
			},
		});

		const mac = fleet({
			user: "mkn",
			machines: {
				// @ts-expect-error a Mac has no disk settings
				mac: computer({ os: "macos", system: { encrypted: true } }),
			},
		});

		const inline = fleet({
			user: "mkn",
			machines: {
				// @ts-expect-error a machine written out by hand gets the same checks
				box: { ...server(), system: { memory: "8 GiB" } },
				// @ts-expect-error machines are hardware; packages go in services
				web: { ...server(), packages: ["git"] },
			},
		});

		const small = fleet({
			machines: { host: hypervisor(), vm: server({ host: "host", system: { memory: "256 MiB" } }) },
			user: "mkn",
		});

		expect(problems(bareMetal)).toContain("machines.box.system.memory: Unexpected key");
		expect(problems(bareMetal)).toContain("machines.vault.system.encrypted: Unexpected key");
		expect(problems(mac)).toContain("machines.mac.system.encrypted: Expected never");
		expect(problems(small)).toContain("machines.vm.system.memory: Expected at least 512 MiB");
		expect(problems(inline)).toContain("machines.box.system.memory: Unexpected key");
		expect(problems(inline)).toContain("machines.web.packages: Unexpected key");
	});

	it("requires the fleet's user once a machine but a hypervisor exists, and says stacks are gone", () => {
		expect(problems(fleet({ machines: { web: server() } }))).toBe(
			'fleet(): user is required, because every machine but a hypervisor has the fleet\'s user. Name it, such as user: "you".',
		);
		expect(Result.isSuccess(decodeFleet(fleet({ machines: { kronos: hypervisor() } })))).toBe(true);
		expect(problems({ machines: {}, stacks: {} })).toContain("fleet(): stacks are gone.");
	});

	it("rejects a machine name that isn't a hostname and keys fleet() doesn't know", () => {
		expect(problems(fleet({ user: "mkn", machines: { Box: server() } }))).toContain(
			"machines.Box: Expected a lowercase hostname label",
		);

		// @ts-expect-error fleet() takes user, machines, services and plugins
		expect(problems(fleet({ machines: {}, extra: true }))).toContain(
			"fleet().extra: Unexpected key",
		);
	});
});
