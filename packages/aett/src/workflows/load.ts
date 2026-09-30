import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Declaration, decodeFleet, type Fleet } from "../domain/fleet.ts";
import { MachineRecord, Operator, type State } from "../domain/state.ts";

/** A problem with the fleet repository: fleet.ts or the state next to it. */
export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
	message: Schema.String,
}) {}

const FleetModule = Schema.Struct({ default: Declaration });

/** Imports `<root>/fleet.ts` and decodes its default export into a fleet. */
export const loadFleet = Effect.fn("loadFleet")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, "fleet.ts");

	if (!(yield* fs.exists(file))) {
		return yield* new FleetError({
			message: `There is no fleet.ts in ${root}. Run aett init to start a fleet here.`,
		});
	}

	yield* Effect.try({
		try: () => createRequire(file).resolve("aett"),
		catch: () =>
			new FleetError({
				message: `fleet.ts imports aett, which is not installed in ${root}. Install the fleet's dependencies first, for example with pnpm install.`,
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

/** Reads the operator and, for each declared machine, its machine.json and whether its facts exist. */
export const readState = Effect.fn("readState")(function* (root: string, fleet: Fleet) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

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
				"state/operator.json is missing. It holds the operator's SSH keys and aett init writes it.",
		});
	}

	const operator = yield* readJson(operatorFile, Operator);

	const machines = yield* Effect.forEach(fleet.machines, ({ name }) =>
		Effect.gen(function* () {
			const directory = path.join(root, "state", name);
			const recordFile = path.join(directory, "machine.json");
			const facts = yield* fs.exists(path.join(directory, "facter.json"));

			const record = (yield* fs.exists(recordFile))
				? yield* readJson(recordFile, MachineRecord)
				: {};

			return [name, { ...record, facts }] as const;
		}),
	);

	return { operator, machines: new Map(machines) } satisfies State;
});
