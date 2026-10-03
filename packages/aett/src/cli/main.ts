#!/usr/bin/env node
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Option } from "effect";
import { Command } from "effect/cli";
import metadata from "../../package.json" with { type: "json" };
import { Assets } from "../adapters/assets.ts";
import { GitHub } from "../adapters/github.ts";
import { Tailscale } from "../adapters/tailscale.ts";
import { Secrets } from "../adapters/secrets.ts";
import { Ssh } from "../adapters/ssh.ts";
import { nixEngine } from "../engine/nix/nix.ts";
import { command } from "./command.ts";
import { fleetAett, handOff } from "./hand-off.ts";

// Node gives each address only 250 ms to connect before it tries the next; on a slow link every
// attempt then times out, as Tailscale's API did. A second each still falls back quickly.
setDefaultAutoSelectFamilyAttemptTimeout(1000);

// This file sits two levels below the package root in both src/ and dist/.
const directory = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

// Inside a fleet that installed its own aett, that one runs; otherwise this one does.
fleetAett(directory).pipe(
	Effect.flatMap(
		Option.match({
			onNone: () =>
				Command.run(command({ directory, version: metadata.version }), {
					version: metadata.version,
				}),
			onSome: handOff,
		}),
	),
	Effect.catchTag("ShowHelp", (error) =>
		error.errors.length === 0 ? Effect.void : Effect.fail(error),
	),
	// Expected failures print their message alone, without a logged stack, and exit with 1.
	Effect.catchTag(
		[
			"ApplyError",
			"CreateError",
			"DestroyError",
			"EngineError",
			"FleetError",
			"GitHubError",
			"HomeError",
			"InstallError",
			"MacError",
			"PinsError",
			"PlatformError",
			"SecretsError",
			"SshError",
			"TailscaleError",
			"UnlockError",
		],
		(error) =>
			Console.error(error.message).pipe(
				Effect.andThen(
					Effect.sync(() => {
						process.exitCode = 1;
					}),
				),
			),
	),
	Effect.provide(Ssh.layer),
	Effect.provide(GitHub.layer),
	Effect.provide(Secrets.layer),
	Effect.provide(Tailscale.layer),
	// The flake and the shipped plugins ship as source in the package, also next to dist/.
	Effect.provide(
		nixEngine(join(directory, "src", "engine", "nix", "flake"), join(directory, "plugins")),
	),
	Effect.provide(Assets.layer(join(directory, "plugins"))),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
