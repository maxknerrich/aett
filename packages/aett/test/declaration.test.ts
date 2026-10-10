import { Option, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet, PluginMetadata } from "../src/domain/fleet.ts";
import { plugin } from "../src/domain/plugin.ts";
import { computer, fleet, hypervisor, mac, nas, server, vm } from "../src/index.ts";

// What decodeFleet reports for a declaration it has to reject.
const problems = (declaration: Declaration, own: Parameters<typeof decodeFleet>[1] = []) =>
	Result.getOrThrow(Result.flip(decodeFleet(declaration, own)));

// The fleet aett works with for a declaration it accepts.
const loaded = (declaration: Declaration, own: Parameters<typeof decodeFleet>[1] = []) =>
	Result.getOrThrow(decodeFleet(declaration, own));

// A service of the fleet's own with settings, which only servers run.
const whoami = plugin({
	name: "whoami",
	options: Schema.Struct({
		greeting: Schema.optionalKey(Schema.String),
		loud: Schema.optionalKey(Schema.Boolean),
	}),
	roles: ["server"],
	endpoints: { web: { port: 8080, web: true } },
});

describe("decodeFleet", () => {
	it("puts packages on targets and groups: machines, tags and default, Homebrew's only on Macs, none on hypervisors", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor({ encrypted: true }),
					zeus: vm({ host: "kronos", memory: 8, tags: ["dev"] }),
					vault: nas(),
					fawkes: mac({ tags: ["dev"] }),
				},
				packages: {
					default: ["git"],
					dev: ["claude-code", "cask.ghostty", "vite-plus"],
					fawkes: ["1password", "firefox@developer-edition", "brew.mas"],
					agents: { zeus: ["pi"] },
				},
			}),
		);

		expect(
			declared.machines.map(({ name, packages, releases, home }) => ({
				name,
				packages,
				releases: releases.map(({ bin }) => bin),
				home,
			})),
		).toEqual([
			{ name: "kronos", packages: ["tailscale"], releases: [], home: [] },
			{
				name: "zeus",
				packages: ["claude-code", "git", "pi", "tailscale"],
				releases: ["vp"],
				home: ["default", "dev", "zeus"],
			},
			{ name: "vault", packages: ["git", "tailscale"], releases: [], home: ["default", "vault"] },
			{
				name: "fawkes",
				packages: [
					"1password",
					"brew.mas",
					"cask.ghostty",
					"cask.tailscale-app",
					"claude-code",
					"firefox@developer-edition",
					"git",
					"vite-plus",
				],
				releases: [],
				home: ["default", "dev", "fawkes"],
			},
		]);

		expect(declared.machines.find(({ name }) => name === "vault")?.encrypted).toBe(true);
		expect(declared.machines.find(({ name }) => name === "zeus")?.vm).toEqual(
			Option.some({ host: "kronos", cpu: 2, memory: 8192, disk: 20480 }),
		);
	});

	it("places a service on targets with settings merged per machine: default, then tags, then the machine", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					web: server({ tags: ["public"] }),
					api: server(),
					fawkes: mac(),
				},
				services: {
					// @ts-expect-error whoami comes from services/whoami/, unknown until aett generates it
					whoami: { default: { greeting: "hi" }, public: { loud: true }, web: { greeting: "hey" } },
					t3code: ["web", "api"],
				},
			}),
			[whoami],
		);

		const settings = (machine: string) =>
			declared.machines
				.find(({ name }) => name === machine)
				?.services.find(({ name }) => name === "whoami")?.options;

		// default reaches every server; fawkes is a Mac, which whoami doesn't run on.
		expect(declared.services.get("whoami")?.instances).toEqual(["web", "api"]);
		expect(settings("web")).toEqual({ greeting: "hey", loud: true });
		expect(settings("api")).toEqual({ greeting: "hi" });
		expect(declared.services.get("t3code")?.instances).toEqual(["web", "api"]);
		expect(declared.machines[0]?.home).toEqual(["default", "public", "whoami", "t3code", "web"]);
	});

	it("gives a service with clients its server and every other machine with the user, but those excluded", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor(),
					vault: nas(),
					zeus: vm({ host: "kronos" }),
					hermes: vm({ host: "kronos", tags: ["throwaway"] }),
					fawkes: mac(),
				},
				services: { backup: { server: "vault", exclude: "throwaway" } },
			}),
		);

		expect(declared.services.get("backup")?.instances).toEqual(["vault"]);
		expect(declared.services.get("backup")?.clients).toEqual(["zeus", "fawkes"]);
	});

	it("checks services: their names, settings and machines", () => {
		const machines = { kronos: hypervisor(), web: server(), fawkes: mac() };

		const greeting = fleet({
			user: "mkn",
			machines,
			services: {
				// @ts-expect-error whoami comes from services/whoami/, so the type knows it once aett generates it
				whoami: { web: { greeting: 1 } },
			},
		});

		const settings = fleet({
			user: "mkn",
			machines,
			services: {
				// @ts-expect-error t3code takes no settings
				t3code: { web: { port: 1 } },
			},
		});

		const unknown = fleet({
			user: "mkn",
			machines,
			services: {
				// @ts-expect-error there is no such service
				nope: "web",
			},
		});

		const backup = fleet({
			user: "mkn",
			machines,
			services: {
				// @ts-expect-error backup names its server
				backup: "web",
			},
		});

		const tailscale = fleet({
			user: "mkn",
			machines,
			services: {
				// @ts-expect-error tailscale is on every machine
				tailscale: "web",
			},
		});

		const target = fleet({
			user: "mkn",
			machines,
			services: {
				// @ts-expect-error a target is a machine, a tag or default
				t3code: "nowhere",
			},
		});

		expect(problems(greeting, [whoami])).toBe("services.whoami.greeting: Expected string, got 1");
		expect(problems(settings)).toBe(
			"services.t3code.port: Unexpected key; t3code takes no settings",
		);
		expect(problems(unknown)).toBe(
			"services.nope: aett ships no service named nope, and the fleet has no services/nope/",
		);
		expect(problems(fleet({ user: "mkn", machines, services: { t3code: "fawkes" } }))).toBe(
			"services.t3code: t3code can't run on fawkes, which is a Mac",
		);
		expect(problems(backup)).toBe(
			'services.backup: Expected { server: "<machine>" }, the machine it runs on',
		);
		expect(problems(tailscale)).toBe(
			"services.tailscale: tailscale is on every machine already and takes no entry",
		);
		expect(problems(target)).toBe('services.t3code: There is no machine or tag named "nowhere"');
	});

	it("checks packages: a target takes a list, a group its targets, and a hypervisor none", () => {
		const declared = fleet({
			user: "mkn",
			machines: { kronos: hypervisor(), web: server() },
			packages: {
				// @ts-expect-error a group takes targets and their packages
				wbe: ["git"],
				kronos: ["git"],
				// @ts-expect-error a group's keys are targets
				tools: { nowhere: ["git"] },
			},
		});

		expect(problems(declared)).toContain(
			'packages.wbe: There is no machine or tag named "wbe". A group of that name takes targets and their packages, such as wbe: { zeus: ["git"] }',
		);
		expect(problems(declared)).toContain(
			"packages.kronos: kronos is a hypervisor, which runs only VMs and services",
		);
		expect(problems(declared)).toContain(
			'packages.tools.nowhere: There is no machine or tag named "nowhere"',
		);
	});

	it("rejects own services named like aett's, secret names that clash or escape, and tags named like machines", () => {
		const users = plugin({ name: "users", secrets: { mkn: { generate: "password" } } });

		expect(
			problems(fleet({ user: "mkn", machines: { web: server() } }), [plugin({ name: "backup" })]),
		).toBe("services/backup/: aett already ships a service named backup");
		expect(
			problems(
				// @ts-expect-error users comes from services/users/
				fleet({ user: "mkn", machines: { web: server() }, services: { users: "web" } }),
				[users],
			),
		).toBe("services: users/mkn is the name of two secrets; rename the service or its secret");
		expect(
			Result.isFailure(
				Schema.decodeUnknownResult(PluginMetadata)(
					{ name: "hello", secrets: { "../../users/mkn": { generate: "password" } } },
					{ onExcessProperty: "error" },
				),
			),
		).toBe(true);
		expect(
			problems(fleet({ user: "mkn", machines: { web: server(), api: server({ tags: ["web"] }) } })),
		).toBe("machines.api.tags: web is a machine's name");
	});

	it("rejects a VM whose host can't run VMs, and settings that don't fit the machine", () => {
		const host = fleet({
			user: "mkn",
			machines: {
				fawkes: mac(),
				// @ts-expect-error a VM runs on a hypervisor, a NAS or a bare-metal server
				box: vm({ host: "fawkes" }),
			},
		});

		const settings = fleet({
			user: "mkn",
			machines: {
				// @ts-expect-error memory is for VMs
				box: server({ memory: 8 }),
				// @ts-expect-error a NAS is always encrypted
				vault: nas({ encrypted: true }),
				// @ts-expect-error a Mac has no disk settings
				fawkes: mac({ encrypted: true }),
			},
		});

		const small = fleet({
			user: "mkn",
			machines: { kronos: hypervisor(), box: vm({ host: "kronos", memory: 0.25 }) },
		});

		expect(problems(host)).toBe(
			"machines.box.host: fawkes is a computer; a VM runs on a hypervisor, a NAS or a bare-metal server",
		);
		expect(problems(settings)).toContain("machines.box.memory: Unexpected key");
		expect(problems(settings)).toContain("machines.vault.encrypted: Unexpected key");
		expect(problems(settings)).toContain(
			"machines.fawkes.encrypted: Unexpected key with value true",
		);
		expect(problems(small)).toContain(
			"machines.box.memory: Expected a value greater than or equal to 0.5",
		);
		expect(
			loaded(
				fleet({ user: "mkn", machines: { vault: nas(), box: vm({ host: "vault", disk: 200 }) } }),
			).machines[1]?.vm,
		).toEqual(Option.some({ host: "vault", cpu: 2, memory: 2048, disk: 204800 }));
	});

	it("requires the fleet's user, says stacks and plugins are gone, and rejects keys and names it doesn't know", () => {
		expect(problems(fleet({ machines: { web: server() } }))).toBe(
			'fleet(): user is required, because every machine but a hypervisor has the fleet\'s user. Name it, such as user: "you".',
		);
		expect(Result.isSuccess(decodeFleet(fleet({ machines: { kronos: hypervisor() } })))).toBe(true);
		expect(problems({ machines: {}, plugins: [] })).toContain(
			"fleet(): stacks and plugins are gone.",
		);
		expect(problems(fleet({ user: "mkn", machines: { Box: server() } }))).toContain(
			"machines.Box: Expected a lowercase hostname label",
		);
		// @ts-expect-error fleet() takes user, machines, services and packages
		expect(problems(fleet({ machines: {}, extra: true }))).toContain(
			"fleet().extra: Unexpected key",
		);
		expect(
			Result.isSuccess(decodeFleet(fleet({ user: "mkn", machines: { desk: computer() } }))),
		).toBe(true);
	});
});
