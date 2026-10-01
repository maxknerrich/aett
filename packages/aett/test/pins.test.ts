import { describe, expect, it } from "vite-plus/test";
import { assetNames, type InputsLock, inputChanges, mergeInputs } from "../src/domain/pins.ts";

// A github input's lock node at `rev`.
const github = (repo: string, rev: string, lastModified: number) => ({
	locked: { owner: "o", repo, rev, narHash: `sha256-${rev}`, lastModified, type: "github" },
	original: { owner: "o", repo, type: "github" },
});

describe("mergeInputs", () => {
	it("adds the inputs aett gained with their nodes, renaming a taken name, and keeps existing pins", () => {
		const pinned: InputsLock = {
			root: "root",
			version: 7,
			nodes: {
				root: { inputs: { nixpkgs: "nixpkgs" } },
				nixpkgs: github("nixpkgs", "old", 1),
			},
		};

		const defaults: InputsLock = {
			root: "root",
			version: 7,
			nodes: {
				root: { inputs: { nixpkgs: "nixpkgs_2", agents: "agents" } },
				nixpkgs_2: github("nixpkgs", "new", 2),
				agents: { ...github("agents", "a1", 3), inputs: { nixpkgs: "nixpkgs" } },
				nixpkgs: github("nixpkgs", "theirs", 4),
			},
		};

		const { lock, added } = mergeInputs(pinned, defaults);

		expect(added).toEqual(["agents"]);
		expect(lock.nodes.root).toEqual({ inputs: { nixpkgs: "nixpkgs", agents: "agents" } });
		expect(lock.nodes.nixpkgs).toEqual(github("nixpkgs", "old", 1));
		expect(lock.nodes.agents?.inputs).toEqual({ nixpkgs: "nixpkgs_2" });
		expect(lock.nodes.nixpkgs_2).toEqual(github("nixpkgs", "theirs", 4));
	});
});

describe("assetNames", () => {
	it("tries musl before glibc and drops the tag's v", () => {
		const release = { github: "o/tool", asset: "tool-{version}-{target}.tar.gz", bin: "tool" };

		expect(assetNames(release, "v1.2.3", "aarch64-linux")).toEqual([
			"tool-1.2.3-aarch64-unknown-linux-musl.tar.gz",
			"tool-1.2.3-aarch64-unknown-linux-gnu.tar.gz",
		]);
	});
});

// A lock with nixpkgs at `rev` and disko fixed.
const lock = (rev: string, lastModified: number): InputsLock => ({
	root: "root",
	version: 7,
	nodes: {
		root: { inputs: { nixpkgs: "nixpkgs", disko: "disko" } },
		nixpkgs: github("nixpkgs", rev, lastModified),
		disko: github("disko", "d000000", 0),
	},
});

describe("inputChanges", () => {
	it("lists each input whose revision moved, with its date", () => {
		expect(inputChanges(lock("aaaaaaaa", 1_790_000_000), lock("bbbbbbbb", 1_790_600_000))).toEqual([
			"nixpkgs: aaaaaaa (2026-09-21) → bbbbbbb (2026-09-28)",
		]);
	});
});
