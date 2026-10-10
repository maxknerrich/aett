import { Context, Layer } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "../domain/plugin.ts";

/** Where the running aett keeps what it ships besides code: the shipped plugins' directories. */
export class Assets extends Context.Service<
	Assets,
	{
		/** The directory holding plugins/<name>/ for each shipped plugin. */
		readonly plugins: string;
	}
>()("aett/adapters/Assets") {
	static readonly layer = (plugins: string) => Layer.succeed(Assets, Assets.of({ plugins }));
}

/**
 * A plugin's directory: the one it names, a relative path from the fleet's
 * `root`, or else aett's own for a shipped plugin.
 */
export const pluginDirectory = (plugins: string, root: string, plugin: Plugin) =>
	plugin.directory === undefined
		? join(plugins, plugin.name)
		: plugin.directory instanceof URL
			? fileURLToPath(plugin.directory)
			: resolve(root, plugin.directory);
