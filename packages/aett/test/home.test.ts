import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
	Entry,
	fillPlaceholders,
	fingerprint,
	hostColor,
	overlay,
	planSync,
	resolveHome,
} from "../src/domain/home.ts";

const file = (path: string, content: string, executable = false) =>
	Entry.File({ path, content, executable });

const link = (path: string, target: string) => Entry.Link({ path, target });

// A manifest or a machine's paths holding these entries.
const at = (...entries: ReadonlyArray<Entry>) =>
	new Map(entries.map((entry) => [entry.path, fingerprint(entry)]));

describe("resolveHome", () => {
	const sets = new Map([
		["shell", [file(".config/fish/config.fish", "fish")]],
		[
			"agents",
			[file(".agents/AGENTS.md", "rules"), link(".claude/CLAUDE.md", "../.agents/AGENTS.md")],
		],
		["claude", [link(".claude/CLAUDE.md", "../.agents/AGENTS.md")]],
		["dev", [file(".config/git/config", "dev")]],
		["work", [file(".config/git/config", "work")]],
		["escape", [link(".evil", "../../etc/passwd"), link(".config/absolute", "/etc/passwd")]],
		["flat", [file(".config", "a file")]],
		["chain", [link("alias", "."), link("escape", "alias/../outside")]],
		["state", [file(".local/state/aett/home.json", "{}")]],
		["dotlocal", [link(".local", ".config")]],
	]);

	it("merges the chosen sets sorted by path, whatever their order, and keeps links", () => {
		const home = resolveHome(sets, ["shell", "agents"]);

		expect(home).toEqual(
			Result.succeed([
				file(".agents/AGENTS.md", "rules"),
				link(".claude/CLAUDE.md", "../.agents/AGENTS.md"),
				file(".config/fish/config.fish", "fish"),
			]),
		);
		expect(resolveHome(sets, ["agents", "shell"])).toEqual(home);
	});

	it("keeps a link into another set", () => {
		expect(Result.isSuccess(resolveHome(sets, ["claude", "shell"]))).toBe(true);
	});

	it("rejects a path that is a file in one set and a directory in another", () => {
		expect(resolveHome(sets, ["flat", "dev", "work"])).toEqual(
			Result.fail(
				[
					".config is a file in flat but a directory in dev and work.",
					".config/git/config is in both dev and work.",
				].join("\n"),
			),
		);
	});

	it("rejects a link that leads through another link, which could leave the home", () => {
		expect(resolveHome(sets, ["chain"])).toEqual(
			Result.fail(
				"dotfiles/chain/escape links to alias/../outside, through the link alias. Links in a set can't lead through other links.",
			),
		);
	});

	it("rejects what stands in the way of aett's manifest", () => {
		expect(resolveHome(sets, ["state"])).toEqual(
			Result.fail(
				"dotfiles/state/.local/state/aett/home.json is in the way of aett's manifest, .local/state/aett/home.json.",
			),
		);
		expect(resolveHome(sets, ["dotlocal"])).toEqual(
			Result.fail(
				"dotfiles/dotlocal/.local is in the way of aett's manifest, .local/state/aett/home.json.",
			),
		);
	});

	it("names every problem at once, and takes a name without a tree as adding nothing", () => {
		expect(resolveHome(sets, ["work", "missing", "escape", "dev"])).toEqual(
			Result.fail(
				[
					".config/git/config is in both dev and work.",
					"dotfiles/escape/.evil links to ../../etc/passwd, which is outside the home.",
					"dotfiles/escape/.config/absolute links to the absolute path /etc/passwd. Links in a set are relative.",
				].join("\n"),
			),
		);
	});
});

describe("fillPlaceholders", () => {
	it("fills the host's name and color and the home, and leaves other placeholders and links alone", () => {
		const entries = [
			file(
				".config/starship.toml",
				"{{host.name}} {{host.color}} {{host.name}} {{home}} {{user}}",
				true,
			),
			link(".link", "{{host.name}}"),
		];

		expect(fillPlaceholders(entries, "zeus", "/home/mkn")).toEqual([
			file(".config/starship.toml", `zeus ${hostColor("zeus")} zeus /home/mkn {{user}}`, true),
			link(".link", "{{host.name}}"),
		]);
	});
});

describe("overlay", () => {
	it("lets the fleet's file win over a plugin's at the same path, above it or below it", () => {
		const shipped = new Map([
			[
				"omintosh",
				[
					file(".config/rift/config.toml", "shipped"),
					file(".config/sketchybar/sketchybarrc", "shipped"),
					file(".config/karabiner/karabiner.json", "shipped"),
				],
			],
		]);

		const own = new Map([
			[
				"omintosh",
				[file(".config/rift/config.toml", "mine"), link(".config/sketchybar", "../bar")],
			],
			["default", [file(".config/fish/config.fish", "fish")]],
		]);

		expect(overlay(shipped, own)).toEqual(
			new Map([
				[
					"omintosh",
					[
						file(".config/karabiner/karabiner.json", "shipped"),
						file(".config/rift/config.toml", "mine"),
						link(".config/sketchybar", "../bar"),
					],
				],
				["default", [file(".config/fish/config.fish", "fish")]],
			]),
		);
	});
});

describe("hostColor", () => {
	it("is a hex color that depends on the name alone", () => {
		expect(hostColor("zeus")).toMatch(/^#[0-9a-f]{6}$/);
		expect(hostColor("zeus")).toBe(hostColor("zeus"));
		expect(hostColor("zeus")).not.toBe(hostColor("hestia"));
	});
});

describe("planSync", () => {
	const config = file(".config/git/config", "new");
	const old = file(".config/git/config", "old");
	const edited = file(".config/git/config", "edited");

	it("writes a new file and records it", () => {
		const plan = planSync([config], at(), at());

		expect(plan).toMatchObject({ write: [config], remove: [], changedLocally: [], changes: true });
		expect(plan.manifest).toEqual(Option.some(at(config)));
	});

	it("does nothing when the machine holds what aett placed", () => {
		expect(planSync([config], at(config), at(config))).toEqual({
			write: [],
			remove: [],
			throughLinks: [],
			changedLocally: [],
			manifest: Option.none(),
			changes: false,
		});
	});

	it("overwrites a file that changed in its set", () => {
		expect(planSync([config], at(old), at(old))).toMatchObject({
			write: [config],
			changedLocally: [],
		});
	});

	it("lists a file edited on the machine before overwriting it", () => {
		expect(planSync([config], at(config), at(edited))).toMatchObject({
			write: [config],
			changedLocally: [config.path],
			manifest: Option.none(),
		});
	});

	it("lists a file aett never placed before overwriting it, and only records one that matches", () => {
		expect(planSync([config], at(), at(edited))).toMatchObject({
			write: [config],
			changedLocally: [config.path],
		});
		expect(planSync([config], at(), at(config))).toMatchObject({
			write: [],
			changedLocally: [],
			manifest: Option.some(at(config)),
			changes: false,
		});
	});

	it("removes a file that left its set, and lists it first when it was edited", () => {
		expect(planSync([], at(old), at(old))).toMatchObject({
			remove: [old.path],
			changedLocally: [],
			manifest: Option.some(at()),
		});
		expect(planSync([], at(old), at(edited))).toMatchObject({
			remove: [old.path],
			changedLocally: [old.path],
		});
	});

	it("forgets a file that left its set and is gone from the machine", () => {
		expect(planSync([], at(old), at())).toMatchObject({
			remove: [],
			manifest: Option.some(at()),
			changes: false,
		});
	});

	it("writes a file beneath a link the sync removes", () => {
		const alias = link("alias", "dir");
		const moved = file("alias/config", "same");
		const before = [alias, file("dir/config", "same")];

		expect(
			planSync([moved], at(...before), new Map([...at(...before), [moved.path, "linked"]])),
		).toMatchObject({
			write: [moved],
			remove: ["alias", "dir/config"],
			throughLinks: [],
			changedLocally: [],
		});
	});

	it("forgets what an interrupted sync left beneath a link, whichever its target", () => {
		const settings = file("config/settings", "same");

		// An interrupted sync placed config -> shared, so config/settings reads shared/settings.
		const machine = new Map([...at(link("config", "shared")), [settings.path, "linked"]]);

		expect(planSync([link("config", "shared")], at(settings), machine)).toMatchObject({
			write: [],
			remove: [],
			changes: false,
		});
		expect(planSync([link("config", "other")], at(settings), machine)).toMatchObject({
			write: [link("config", "other")],
			remove: [],
			manifest: Option.some(at(link("config", "other"))),
		});
	});

	it("won't write through a link it leaves in place", () => {
		const settings = file("config/settings", "new");

		expect(
			planSync([settings], at(), new Map([["config/settings", "linked"]])).throughLinks,
		).toEqual([settings.path]);
	});

	it("rewrites a link whose target or a file whose executable bit changed", () => {
		const moved = link(".claude/CLAUDE.md", "../.agents/AGENTS.md");
		const script = file(".local/bin/hello", "echo hi", true);
		const before = [link(moved.path, "../AGENTS.md"), file(script.path, "echo hi")];

		expect(planSync([moved, script], at(...before), at(...before))).toMatchObject({
			write: [moved, script],
			changedLocally: [],
		});
	});
});
