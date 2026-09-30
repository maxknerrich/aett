import { Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { fleet, machine } from "../src/index.ts";

// What decodeFleet reports for a declaration it has to reject.
const problems = (declaration: Declaration) =>
	Result.getOrThrow(Result.flip(decodeFleet(declaration)));

describe("decodeFleet", () => {
	it("accepts what fleet() and machine() declare", () => {
		const declared = fleet({
			machines: [
				machine("box", { role: "hypervisor" }),
				machine("web-1", {
					role: "server",
					packages: ["htop", "python3Packages.rich"],
					channel: "unstable",
					disk: { encrypted: true },
				}),
			],
		});

		expect(decodeFleet(declared)).toEqual(Result.succeed(declared));
	});

	it.each(["Box", "-box", "box-", "b_x", "1box", "a".repeat(64)])(
		"rejects %s as a machine name",
		(name) => {
			expect(problems({ machines: [{ name, role: "server" }] })).toContain(
				`machine("${name}") name: Expected a lowercase hostname label`,
			);
		},
	);

	it("rejects a name used twice", () => {
		const box = { name: "box", role: "server" };

		expect(problems({ machines: [box, box] })).toBe(
			'machine("box") name: Expected a unique name, got "box" again',
		);
	});

	it("rejects an unknown role", () => {
		expect(problems({ machines: [{ name: "box", role: "desktop" }] })).toBe(
			'machine("box") role: Expected "hypervisor" | "server" | "computer", got "desktop"',
		);
	});

	it("rejects an encryption setting that is not a boolean", () => {
		expect(
			problems({ machines: [{ name: "box", role: "server", disk: { encrypted: "yes" } }] }),
		).toBe('machine("box") disk.encrypted: Expected boolean, got "yes"');
	});

	// A misspelled `encrypted` must not leave the disk plain unnoticed.
	it("rejects an unknown option", () => {
		expect(
			problems({ machines: [{ name: "box", role: "server", disk: { encrpyted: true } }] }),
		).toBe('machine("box") disk.encrpyted: Unexpected key with value true');
	});

	it("rejects an unknown fleet key that the loader's declaration check lets through", () => {
		const declaration = Schema.decodeUnknownSync(Declaration)({ machines: [], machine: [] });

		expect(problems(declaration)).toContain("fleet() machine:");
	});

	it("rejects a package that is not a nixpkgs attribute path", () => {
		expect(
			problems({ machines: [{ name: "box", role: "server", packages: ["htop", "pkgs/htop"] }] }),
		).toContain('machine("box") packages: Expected a nixpkgs attribute path');
	});
});
