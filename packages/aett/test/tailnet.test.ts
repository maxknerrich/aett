import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { mergePolicy, policyNeeds } from "../src/domain/tailnet.ts";
import { computer, fleet, hypervisor, nas, server } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

const needs = {
	tags: ["tag:server", "tag:unlock"],
	grants: [{ src: ["tag:server"], dst: ["tag:server"], ip: ["tcp:51515"] }],
};

describe("policyNeeds", () => {
	it("tags NixOS machines by role, adds tag:unlock for encrypted ones, and grants plugins' endpoints by tag; Macs have no tag", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor(),
					hades: server({ host: "kronos" }),
					vault: nas(),
					fawkes: computer({ os: "macos" }),
				},
				services: { backup: "hades" },
			}),
		);

		expect(policyNeeds(declared)).toEqual({
			tags: ["tag:hypervisor", "tag:nas", "tag:server", "tag:unlock"],
			grants: [{ src: ["tag:nas", "tag:server"], dst: ["tag:server"], ip: ["tcp:51515"] }],
		});
	});
});

describe("mergePolicy", () => {
	it("adds missing tags and grants on lines of their own, leaving the rest as it was", () => {
		const policy = `// The tailnet's policy.
{
	"tagOwners": {
		"tag:server": ["autogroup:admin"], // servers
	},
	"grants": [
		{"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
	],
}
`;

		expect(mergePolicy(policy, needs)).toEqual(
			Result.succeed(
				Option.some(`// The tailnet's policy.
{
	"tagOwners": {
		"tag:server": ["autogroup:admin"], // servers
		"tag:unlock": ["autogroup:admin"],
	},
	"grants": [
		{"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
		{"src": ["tag:server"], "dst": ["tag:server"], "ip": ["tcp:51515"]},
	],
}
`),
			),
		);
	});

	it("starts tagOwners and grants a policy lacks, and changes nothing once a policy covers the needs", () => {
		const merged = mergePolicy(`{\n  "acls": []\n}\n`, needs);

		expect(merged).toEqual(
			Result.succeed(
				Option.some(`{
  "acls": [],
  "tagOwners": {
    "tag:server": ["autogroup:admin"],
    "tag:unlock": ["autogroup:admin"]
  },
  "grants": [
    {"src": ["tag:server"], "dst": ["tag:server"], "ip": ["tcp:51515"]}
  ]
}
`),
			),
		);

		expect(
			mergePolicy(
				`{"tagOwners": {"tag:server": [], "tag:unlock": []}, "grants": [{"src": ["*"], "dst": ["*"], "ip": ["*"]}]}`,
				needs,
			),
		).toEqual(Result.succeed(Option.none()));
	});
});
