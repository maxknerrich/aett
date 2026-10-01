import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
	aettDependency,
	fleetSource,
	newMachineName,
	packageManager,
	parseMachineFlag,
} from "../src/domain/scaffold.ts";
import { machine } from "../src/index.ts";

describe("parseMachineFlag", () => {
	it("reads name:role and name:role:encrypted", () => {
		expect(parseMachineFlag("box:hypervisor")).toEqual(
			Option.some(machine("box", { role: "hypervisor" })),
		);
		expect(parseMachineFlag("nas:server:encrypted")).toEqual(
			Option.some(machine("nas", { role: "server", disk: { encrypted: true } })),
		);
	});

	it.each(["box", "box:router", "Box:server", "box:server:plain", "box:server:encrypted:x"])(
		"rejects %s",
		(value) => {
			expect(parseMachineFlag(value)).toEqual(Option.none());
		},
	);
});

describe("fleetSource", () => {
	it("declares no machines without importing machine()", () => {
		expect(fleetSource([])).toBe(
			'import { fleet } from "aett"\n\nexport default fleet({\n\tmachines: [],\n})\n',
		);
	});

	it("declares each machine with its role and encryption", () => {
		expect(
			fleetSource([
				machine("box", { role: "hypervisor" }),
				machine("nas", { role: "server", disk: { encrypted: true } }),
			]),
		).toBe(
			[
				'import { fleet, machine } from "aett"',
				"",
				"export default fleet({",
				"\tmachines: [",
				'\t\tmachine("box", { role: "hypervisor" }),',
				'\t\tmachine("nas", { role: "server", disk: { encrypted: true } }),',
				"\t],",
				"})",
				"",
			].join("\n"),
		);
	});
});

describe("packageManager", () => {
	it("uses the package manager in npm_config_user_agent, else npm", () => {
		expect(packageManager(Option.some("pnpm/10.18.0 npm/? node/v24.21.0 darwin arm64"))).toBe(
			"pnpm",
		);
		expect(packageManager(Option.some("deno/2.5.0"))).toBe("npm");
		expect(packageManager(Option.none())).toBe("npm");
	});
});

describe("newMachineName", () => {
	it("accepts a free hostname and rejects a taken or invalid one", () => {
		const machines = [machine("box", { role: "hypervisor" })];

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
