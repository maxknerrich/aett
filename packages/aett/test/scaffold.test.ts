import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
	aettDependency,
	duplicateName,
	fleetSource,
	type NewMachine,
	newMachineName,
	packageManager,
	parseMachineFlag,
} from "../src/domain/scaffold.ts";

// A first machine as create collects it.
const newMachine = (name: string, role: NewMachine["role"], extra: Partial<NewMachine> = {}) => ({
	name,
	role,
	mac: false,
	encrypted: false,
	...extra,
});

describe("parseMachineFlag", () => {
	it("reads name:role, name:role:encrypted and name:computer:macos", () => {
		expect(parseMachineFlag("box:hypervisor")).toEqual(
			Option.some(newMachine("box", "hypervisor")),
		);
		expect(parseMachineFlag("nas:server:encrypted")).toEqual(
			Option.some(newMachine("nas", "server", { encrypted: true })),
		);
		expect(parseMachineFlag("fawkes:computer:macos")).toEqual(
			Option.some(newMachine("fawkes", "computer", { mac: true })),
		);
	});

	it.each([
		"box",
		"box:router",
		"Box:server",
		"box:server:plain",
		"box:server:macos",
		"box:server:encrypted:x",
	])("rejects %s", (value) => {
		expect(parseMachineFlag(value)).toEqual(Option.none());
	});
});

describe("fleetSource", () => {
	it("declares the user and no machines with only fleet() imported", () => {
		expect(fleetSource("mkn", [], Option.none())).toBe(
			'import { fleet } from "aett"\n\nexport default fleet({\n\tuser: "mkn",\n\tmachines: {},\n})\n',
		);
	});

	it("declares each machine by its role and the Mac's apps and brews in a pack named after it", () => {
		expect(
			fleetSource(
				"mkn",
				[
					newMachine("kronos", "hypervisor", { encrypted: true }),
					newMachine("vault", "nas", { encrypted: true }),
					newMachine("web-1", "server"),
					newMachine("fawkes", "computer", { mac: true }),
				],
				Option.some({ mac: "fawkes", apps: ["ghostty", "raycast"], brews: ["mas"] }),
			),
		).toBe(
			[
				'import { computer, fleet, hypervisor, nas, server } from "aett"',
				"",
				"export default fleet({",
				'\tuser: "mkn",',
				"\tmachines: {",
				"\t\tkronos: hypervisor({ system: { encrypted: true } }),",
				"\t\tvault: nas(),",
				'\t\t"web-1": server(),',
				'\t\tfawkes: computer({ os: "macos" }),',
				"\t},",
				"\tservices: {",
				'\t\tfawkes: { on: "fawkes", apps: ["ghostty", "raycast"], brews: ["mas"] },',
				"\t},",
				"})",
				"",
			].join("\n"),
		);
	});
});

describe("fleetSource adopting a Mac named like one of aett's entries", () => {
	it("puts its apps in a pack named apps instead", () => {
		expect(
			fleetSource(
				"mkn",
				[newMachine("backup", "computer", { mac: true })],
				Option.some({ mac: "backup", apps: ["ghostty"], brews: [] }),
			),
		).toContain('\t\tapps: { on: "backup", apps: ["ghostty"] },');
	});
});

describe("duplicateName", () => {
	it("finds a name used twice", () => {
		expect(duplicateName([newMachine("box", "server"), newMachine("box", "computer")])).toEqual(
			Option.some("box"),
		);
		expect(duplicateName([newMachine("box", "server"), newMachine("nas", "server")])).toEqual(
			Option.none(),
		);
	});
});

describe("packageManager", () => {
	it("uses npm or pnpm from npm_config_user_agent, else npm", () => {
		expect(packageManager(Option.some("pnpm/10.18.0 npm/? node/v24.21.0 darwin arm64"))).toBe(
			"pnpm",
		);
		expect(packageManager(Option.some("yarn/4.9.0 npm/? node/v24.21.0"))).toBe("npm");
		expect(packageManager(Option.none())).toBe("npm");
	});
});

describe("newMachineName", () => {
	it("accepts a free hostname and rejects a taken or invalid one", () => {
		const machines = [newMachine("box", "hypervisor")];

		expect(newMachineName(machines, "nas")).toEqual(Result.succeed("nas"));
		expect(Result.isFailure(newMachineName(machines, "box"))).toBe(true);
		expect(Result.isFailure(newMachineName(machines, "Nas"))).toBe(true);
	});
});

describe("aettDependency", () => {
	it("depends on a checkout with a link the package manager won't install from, else on the version", () => {
		const checkout = Option.some("/src/aett/packages/aett");

		expect(aettDependency("npm", checkout, "1.2.0")).toBe("file:/src/aett/packages/aett");
		expect(aettDependency("pnpm", checkout, "1.2.0")).toBe("link:/src/aett/packages/aett");
		expect(aettDependency("npm", Option.none(), "1.2.0")).toBe("^1.2.0");
	});
});
