import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import type { Pins } from "../src/domain/pins.ts";
import { describeFleet } from "../src/domain/show.ts";
import type { State } from "../src/domain/state.ts";
import { fleet, hypervisor, mac, release, vm } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

describe("describeFleet", () => {
	it("prints each machine with its tags, services, endpoints, packages by source and dotfiles", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor({ encrypted: true }),
					hades: vm({ host: "kronos" }),
					fawkes: mac({ tags: ["dev"] }),
				},
				services: { backup: { server: "hades" } },
				packages: {
					fawkes: [
						"git",
						"cask.ghostty",
						release({ github: "o/vp", asset: "vp-{target}", bin: "vp" }),
					],
				},
			}),
		);

		const state: State = {
			operator: {
				sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKey operator@mac"],
				ageKeys: ["age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d"],
			},
			machines: new Map([["hades", { facts: false, tailnetName: "hades.example.ts.net" }]]),
		};

		const pins: Pins = {
			inputs: { nodes: { root: {} }, root: "root", version: 7 },
			releases: { "o/vp": { asset: "vp-{target}", bin: "vp", version: "v1.0.0", assets: {} } },
			packages: {
				git: { darwin: "nixpkgs" },
				kopia: { linux: "nixpkgs", darwin: "nixpkgs" },
			},
		};

		expect(describeFleet(declared, state, pins)).toBe(
			[
				"kronos  hypervisor, encrypted · not on the tailnet yet",
				"        services  tailscale",
				"        packages  tailscale (not pinned yet)",
				"hades   server on kronos, 2 CPUs, 2 GiB memory, 20 GiB disk · hades.example.ts.net",
				"        services  tailscale, backup",
				"        endpoints backup repository hades.example.ts.net:51515",
				"        packages  kopia (nixpkgs) · tailscale (not pinned yet)",
				"        dotfiles  dotfiles/default/, dotfiles/server/, dotfiles/backup/, dotfiles/hades/",
				"fawkes  computer, a Mac · not on the tailnet yet",
				"        tags      dev",
				"        services  tailscale, backup client of hades",
				"        packages  ghostty, tailscale-app (cask) · git, kopia (nixpkgs) · vp v1.0.0 (o/vp)",
				"        dotfiles  dotfiles/default/, dotfiles/dev/, dotfiles/computer/, dotfiles/fawkes/",
			].join("\n"),
		);
	});
});
