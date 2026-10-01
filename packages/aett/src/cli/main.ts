#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Option } from "effect";
import { Command } from "effect/cli";
import metadata from "../../package.json" with { type: "json" };
import { Secrets } from "../adapters/secrets.ts";
import { Ssh } from "../adapters/ssh.ts";
import { nixEngine } from "../engine/nix/nix.ts";
import { command } from "./command.ts";
import { fleetAett, handOff } from "./hand-off.ts";

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
			"EngineError",
			"FleetError",
			"InstallError",
			"PlatformError",
			"SecretsError",
			"SshError",
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
	Effect.provide(Secrets.layer),
	// The flake ships as source in the package, also next to dist/.
	Effect.provide(nixEngine(join(directory, "src", "engine", "nix", "flake"))),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
