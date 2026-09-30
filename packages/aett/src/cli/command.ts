import { Command } from "effect/cli";

export const command = Command.make("aett").pipe(
	Command.withDescription("Manage macOS and NixOS fleets."),
);
