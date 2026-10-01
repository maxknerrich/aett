import { Console, Effect, Path } from "effect";
import type { Fleet } from "../domain/fleet.ts";
import type { State } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";
import { loadFleet, readState } from "./load.ts";

/**
 * Loads the fleet and its state and has the engine write the build to
 * `<root>/.aett/build/`. Returns the build with the fleet and state it was
 * made from.
 */
export const emit = Effect.fn("emit")(function* (root: string) {
	const engine = yield* Engine;
	const fleet = yield* loadFleet(root);
	const state = yield* readState(root, fleet);
	const build = yield* engine.emit(root, fleet, state);

	return { build, fleet, state };
});

/**
 * Emits the build, then evaluates the machines it covers and reports the rest
 * as not discovered or not installed yet.
 */
export const compile = Effect.fn("compile")(function* (root: string) {
	const path = yield* Path.Path;
	const engine = yield* Engine;
	const { build, fleet, state } = yield* emit(root);

	yield* Console.log(`Wrote ${path.relative(root, build.directory)}/`);

	yield* Effect.forEach(fleet.machines, ({ name }) =>
		build.machines.includes(name)
			? engine.evaluate(build, name).pipe(Effect.flatMap((drv) => Console.log(`${name}: ${drv}`)))
			: Console.log(`${name}: ${notBuilt(fleet, state, name)}`),
	);
});

// Why the build leaves a machine out.
const notBuilt = (fleet: Fleet, state: State, name: string) => {
	const unsupported = fleet.machines.find((machine) => machine.name === name)?.unsupported ?? [];

	if (unsupported.length > 0) return `not supported yet: ${unsupported.join(", ")}`;

	return state.machines.get(name)?.facts === true ? "not installed yet" : "not discovered yet";
};
