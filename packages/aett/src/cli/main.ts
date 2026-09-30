#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/cli";
import metadata from "../../package.json" with { type: "json" };
import { command } from "./command.ts";

Command.run(command, { version: metadata.version }).pipe(
	Effect.catchTag("ShowHelp", (error) =>
		error.errors.length === 0 ? Effect.void : Effect.fail(error),
	),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
