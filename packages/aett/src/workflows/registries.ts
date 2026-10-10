import { Console, Effect, FileSystem, Path } from "effect";
import { Homebrew } from "../adapters/homebrew.ts";
import type { Pins } from "../domain/pins.ts";
import { Engine } from "../engine/engine.ts";
import type { RegistryName } from "../index.ts";

/** Where aett writes the registries' package names, which the editor completes in fleet.ts. */
export const registriesFile = ".aett/packages.d.ts";

/** Where aett writes the fleet's own services, which fleet.ts places and the editor checks. */
export const servicesFile = ".aett/services.d.ts";

// What a fleet's tsconfig.json needs for the editor: fleet.ts and its services, and aett's generated
// declarations. Dotfiles are the machines' files, not the fleet's code, even when they're TypeScript.
const tsconfig = {
	compilerOptions: {
		strict: true,
		noEmit: true,
		target: "es2023",
		module: "nodenext",
		allowImportingTsExtensions: true,
		skipLibCheck: true,
	},
	include: ["**/*.ts", ".aett/*.d.ts"],
	exclude: ["**/dotfiles"],
};

// The declaration that fills in aett's Registries with every name.
const declaration = (names: Readonly<Record<RegistryName, ReadonlyArray<string>>>) =>
	[
		"// Every package name in the fleet's registries: the pinned Nix inputs and Homebrew's catalog.",
		"// aett writes it on create and update; the editor completes the names in fleet.ts.",
		"export {};",
		'declare module "aett" {',
		"\tinterface Registries {",
		...Object.entries(names).map(
			([registry, listed]) =>
				`\t\t${JSON.stringify(registry)}: ${listed.length === 0 ? "never" : listed.map((name) => JSON.stringify(name)).join(" | ")};`,
		),
		"\t}",
		"}",
		"",
	].join("\n");

/**
 * Writes every package name in the fleet's registries into
 * .aett/packages.d.ts, from the Nix inputs `pins` locks and Homebrew's
 * catalog, and gives the fleet the tsconfig.json and .gitignore line that go
 * with it. Without them names still work, just uncompleted, so a failure
 * only says so.
 */
export const writeRegistries = Effect.fn("writeRegistries")(
	function* (root: string, pins: Pins) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const engine = yield* Engine;
		const homebrew = yield* Homebrew;

		const nix = yield* engine.packageNames(pins.inputs);
		const { casks, formulae } = yield* homebrew.catalog;
		const file = path.join(root, registriesFile);
		const fresh = !(yield* fs.exists(file));

		yield* fs.makeDirectory(path.dirname(file), { recursive: true });
		yield* fs.writeFileString(
			file,
			declaration({ ...nix, cask: casks, brew: formulae } satisfies Record<
				RegistryName,
				ReadonlyArray<string>
			>),
		);

		const config = path.join(root, "tsconfig.json");

		if (!(yield* fs.exists(config))) {
			yield* fs.writeFileString(config, `${JSON.stringify(tsconfig, null, "\t")}\n`);
		}

		// Generated, and as large as the registries, so it stays out of Git.
		const ignore = path.join(root, ".gitignore");
		const ignored = (yield* fs.exists(ignore)) ? yield* fs.readFileString(ignore) : "";

		if (!ignored.split("\n").some((line) => line === ".aett/" || line === registriesFile)) {
			const separator = ignored === "" || ignored.endsWith("\n") ? "" : "\n";

			yield* fs.writeFileString(ignore, `${ignored}${separator}${registriesFile}\n`);
		}

		if (fresh) {
			yield* Console.log(
				`Wrote ${registriesFile}: your editor completes package names in fleet.ts, such as nixpkgs.git or cask.raycast.`,
			);
		}
	},
	(effect) =>
		effect.pipe(
			Effect.catchTags({
				EngineError: (error) => noNames(error.message),
				HomebrewError: (error) => noNames(error.message),
				PlatformError: (error) => noNames(error.message),
			}),
		),
);

// Says why the editor won't complete package names for now.
const noNames = (why: string) =>
	Console.log(`Your editor won't complete package names in fleet.ts for now. ${why}`);

/** One of the fleet's own services as the declaration names it: its folder, and whether it has a service.ts. */
export interface OwnService {
	readonly name: string;
	readonly defined: boolean;
}

// The declaration that fills in aett's Services with the fleet's own.
const servicesDeclaration = (own: ReadonlyArray<OwnService>) =>
	[
		"// The fleet's own services, from services/<name>/. aett writes it whenever it reads the fleet.",
		"export {};",
		'declare module "aett" {',
		"\tinterface Services {",
		...own.map(({ name, defined }) =>
			defined
				? `\t\t${JSON.stringify(name)}: typeof import(${JSON.stringify(`../services/${name}/service.ts`)}).default;`
				: `\t\t${JSON.stringify(name)}: {};`,
		),
		"\t}",
		"}",
		"",
	].join("\n");

/**
 * Writes the fleet's own services into .aett/services.d.ts when they changed,
 * so fleet.ts places them with their settings checked. It is small and made
 * again on every run.
 */
export const writeServices = Effect.fn("writeServices")(function* (
	root: string,
	own: ReadonlyArray<OwnService>,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, servicesFile);
	const content = servicesDeclaration(own);

	if ((yield* fs.exists(file)) && (yield* fs.readFileString(file)) === content) return;

	yield* fs.makeDirectory(path.dirname(file), { recursive: true });
	yield* fs.writeFileString(file, content);
});
