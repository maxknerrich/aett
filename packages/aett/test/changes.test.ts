import { describe, expect, it } from "vite-plus/test";
import { describeChanges } from "../src/domain/changes.ts";
import { brewfileEntries, undeclaredHomebrew } from "../src/domain/homebrew.ts";

describe("describeChanges", () => {
	it("leads with the commands that go and come, then the declared packages and the system, and counts the rest", () => {
		const diff = [
			"darwin-system: 26.11 → 26.05, -19.1 KiB",
			"git: 2.55.0 → 2.54.0, -12.6 MiB",
			"perl5.42.3-URI: 5.36 removed, -200.3 KiB",
			"perl5.42.0-URI: 5.21 added, 158.1 KiB",
			"ripgrep: ∅ → 15.1.0, +5.0 MiB",
		].join("\n");

		expect(
			describeChanges({ diff, removed: ["just", "starship"], added: ["rg"] }, [
				"git",
				"nixpkgs.ripgrep",
			]),
		).toBe(
			[
				"  Commands it removes: just, starship",
				"  Commands it adds: rg",
				"  darwin-system: 26.11 → 26.05, -19.1 KiB",
				"  git: 2.55.0 → 2.54.0, -12.6 MiB",
				"  ripgrep: ∅ → 15.1.0, +5.0 MiB",
				"  …and 2 other packages underneath.",
			].join("\n"),
		);

		expect(describeChanges({ diff: "", removed: [], added: [] }, ["git"])).toBe("");
	});
});

describe("undeclaredHomebrew", () => {
	it("lists the casks, formulae and taps a Brewfile doesn't, one from a tap by its full name or its own", () => {
		const declared = brewfileEntries(
			[
				'tap "homebrew/cask"',
				'brew "mas"',
				'brew "owner/tap/tool"',
				'cask "ghostty"',
				'cask "other/tap/app"',
				'mas "Xcode", id: 497799835',
			].join("\n"),
		);

		expect(
			undeclaredHomebrew(
				{
					casks: ["ghostty", "app", "zoom"],
					brews: ["mas", "owner/tap/tool", "acsandmann/tap/rift"],
					taps: ["homebrew/cask", "owner/tap", "other/tap", "acsandmann/tap"],
				},
				declared,
			),
		).toEqual(["cask zoom", "formula acsandmann/tap/rift", "tap acsandmann/tap"]);
	});
});
