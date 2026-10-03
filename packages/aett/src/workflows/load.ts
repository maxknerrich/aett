import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Console, Effect, FileSystem, Option, Path, type PlatformError, Schema } from "effect";
import { Declaration, decodeFleet, type Fleet } from "../domain/fleet.ts";
import { MachineRecord, Operator, type State } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";

/** A problem with the fleet repository: fleet.ts or the state next to it. */
export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
	message: Schema.String,
}) {}

const FleetModule = Schema.Struct({ default: Declaration });

/** The nearest directory from `cwd` upwards that holds fleet.ts, the way git finds its repository. */
export const findFleet = Effect.fn("findFleet")(function* (cwd: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const search = (
		directory: string,
	): Effect.Effect<Option.Option<string>, PlatformError.PlatformError> =>
		fs.exists(path.join(directory, "fleet.ts")).pipe(
			Effect.flatMap((found) => {
				const parent = path.dirname(directory);

				if (found) return Effect.succeed(Option.some(directory));

				return parent === directory ? Effect.succeed(Option.none()) : search(parent);
			}),
		);

	return yield* search(cwd);
});

/** The fleet a command works on: the nearest one from `cwd` upwards. Says which when it is not `cwd` itself. */
export const fleetRoot = Effect.fn("fleetRoot")(function* (cwd: string) {
	const root = yield* Effect.flatMap(findFleet(cwd), (found) =>
		Effect.fromOption(
			found,
			() =>
				new FleetError({
					message: `There is no fleet.ts in ${cwd} or any directory above it. cd into a fleet, or start one with aett create.`,
				}),
		),
	);

	if (root !== cwd) yield* Console.log(`Using the fleet in ${root}`);

	return root;
});

/** Imports `<root>/fleet.ts` and decodes its default export into a fleet. */
export const loadFleet = Effect.fn("loadFleet")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, "fleet.ts");

	if (!(yield* fs.exists(file))) {
		return yield* new FleetError({
			message: `There is no fleet.ts in ${root}. Run aett from a fleet directory, or start one with aett create.`,
		});
	}

	yield* Effect.try({
		try: () => createRequire(file).resolve("aett"),
		catch: () =>
			new FleetError({
				message: `fleet.ts imports aett, which is not installed in ${root}. Install the fleet's dependencies first, for example with npm install.`,
			}),
	});

	const { default: declaration } = yield* Effect.tryPromise({
		try: () => import(pathToFileURL(file).href),
		catch: (cause) =>
			new FleetError({
				message: `Could not load fleet.ts: ${cause instanceof Error ? cause.message : String(cause)}`,
			}),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(FleetModule)),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(
				new FleetError({ message: "fleet.ts must export default fleet({ machines: [...] })." }),
			),
		),
	);

	return yield* Effect.fromResult(decodeFleet(declaration)).pipe(
		Effect.mapError((problems) => new FleetError({ message: `fleet.ts is invalid:\n${problems}` })),
	);
});

/**
 * Reads the operator and, for each declared machine and each machine state
 * still records, its machine.json and whether its facts exist.
 */
export const readState = Effect.fn("readState")(function* (root: string, fleet: Fleet) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const engine = yield* Engine;

	// Decodes a JSON state file, naming it relative to the fleet root on failure.
	const readJson = <A>(file: string, schema: Schema.Decoder<A>) =>
		fs.readFileString(file).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
			Effect.catchTag("SchemaError", (error) =>
				Effect.fail(
					new FleetError({ message: `${path.relative(root, file)} is invalid: ${error.message}` }),
				),
			),
		);

	const operatorFile = path.join(root, "state", "operator.json");

	if (!(yield* fs.exists(operatorFile))) {
		return yield* new FleetError({
			message:
				"state/operator.json is missing. It holds the operator's SSH and age keys and aett create writes it.",
		});
	}

	const operator = yield* readJson(operatorFile, Operator);

	const stateDirectory = path.join(root, "state");

	// Directories of machines fleet.ts may no longer declare, such as a removed guest not yet destroyed.
	const recorded = yield* fs
		.readDirectory(stateDirectory)
		.pipe(
			Effect.flatMap((entries) =>
				Effect.filter(entries, (entry) =>
					fs
						.stat(path.join(stateDirectory, entry))
						.pipe(
							Effect.flatMap(({ type }) =>
								type === "Directory"
									? fs.exists(path.join(stateDirectory, entry, "machine.json"))
									: Effect.succeed(false),
							),
						),
				),
			),
		);

	const names = [...new Set([...fleet.machines.map(({ name }) => name), ...recorded])];

	const recordedMachines = yield* Effect.forEach(names, (name) =>
		Effect.gen(function* () {
			const directory = path.join(root, "state", name);
			const recordFile = path.join(directory, "machine.json");
			const reported = yield* engine.discovered(root, name);

			const record = (yield* fs.exists(recordFile))
				? yield* readJson(recordFile, MachineRecord)
				: {};

			return {
				name,
				record,
				facts: Option.isSome(reported),
				platform: Option.getOrUndefined(
					Option.orElse(reported, () => Option.fromUndefinedOr(record.system)),
				),
			};
		}),
	);

	// A VM runs on its host's platform.
	const platforms = new Map(recordedMachines.map(({ name, platform }) => [name, platform]));

	const hostOf = (name: string) =>
		fleet.machines
			.find((machine) => machine.name === name)
			?.vm.pipe(
				Option.map(({ host }) => host),
				Option.getOrUndefined,
			);

	const machines = recordedMachines.map(({ name, record, facts, platform }) => {
		const host = hostOf(name) ?? record.host;
		const known = platform ?? (host === undefined ? undefined : platforms.get(host));

		return [name, { ...record, facts, platform: known }] as const;
	});

	return { operator, machines: new Map(machines) } satisfies State;
});

/** Adds `changes` to state/<name>/machine.json, keeping what it records already. */
export const updateRecord = Effect.fn("updateRecord")(function* (
	root: string,
	name: string,
	changes: typeof MachineRecord.Type,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = path.join(root, "state", name);
	const file = path.join(directory, "machine.json");

	const recorded = (yield* fs.exists(file))
		? yield* fs.readFileString(file).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(MachineRecord))),
				Effect.catchTag("SchemaError", (error) =>
					Effect.fail(
						new FleetError({ message: `state/${name}/machine.json is invalid: ${error.message}` }),
					),
				),
			)
		: {};

	yield* fs.makeDirectory(directory, { recursive: true });
	yield* fs.writeFileString(file, `${JSON.stringify({ ...recorded, ...changes }, null, "\t")}\n`);
});
