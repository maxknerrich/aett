import { describe, expect, it } from "vite-plus/test";
import { resolveStacks } from "../src/domain/stacks.ts";

const server = { name: "nas", computer: false };

const laptop = { name: "laptop", computer: true };

describe("resolveStacks", () => {
	it("adds a stack's top level everywhere and its machine entries only where named", () => {
		const stacks = [
			{ packages: ["fish"] },
			{ machines: { nas: { packages: ["git"] } } },
			{ packages: ["fish", "htop"], machines: { laptop: { packages: ["gh"] } } },
		];

		expect(resolveStacks(stacks, server).packages).toEqual(["fish", "git", "htop"]);
		expect(resolveStacks(stacks, laptop).packages).toEqual(["fish", "gh", "htop"]);
		expect(resolveStacks(stacks.toReversed(), laptop)).toEqual(resolveStacks(stacks, laptop));
	});

	it("brings top-level apps only to computers and a top-level home only to servers", () => {
		const stacks = [{ apps: ["firefox"], home: true as const }];

		expect(resolveStacks(stacks, laptop)).toMatchObject({ apps: ["firefox"], home: false });
		expect(resolveStacks(stacks, server)).toMatchObject({ apps: [], home: true });
	});

	it("keeps a service off when any stack turns it off, whatever the order", () => {
		const on = { services: { tailscale: {} } };
		const off = { machines: { nas: { services: { tailscale: false as const } } } };

		expect(resolveStacks([on, off], server).services).toEqual([]);
		expect(resolveStacks([off, on], server).services).toEqual([]);
		expect(resolveStacks([on, off], laptop).services).toEqual(["tailscale"]);
	});

	it("lets a machine entry turn a service back on within its own stack", () => {
		const stacks = [
			{
				services: { tailscale: false as const },
				machines: { nas: { services: { tailscale: {} } } },
			},
		];

		expect(resolveStacks(stacks, server).services).toEqual(["tailscale"]);
		expect(resolveStacks(stacks, laptop).services).toEqual([]);
	});
});
