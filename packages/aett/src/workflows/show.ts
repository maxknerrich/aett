import { Console, Effect, Option } from "effect";
import type { Pins } from "../domain/pins.ts";
import { describeFleet } from "../domain/show.ts";
import { Engine } from "../engine/engine.ts";
import { loadFleet, readState } from "./load.ts";
import { readPins } from "./pins.ts";

/** Prints the fleet by machine from fleet.ts, state and the pins, without contacting any machine. */
export const show = Effect.fn("show")(function* (root: string) {
	const fleet = yield* loadFleet(root);
	const state = yield* readState(root, fleet);
	const defaults = yield* (yield* Engine).defaultInputs;

	const pins = Option.getOrElse(yield* readPins(root), (): Pins => ({
		inputs: defaults,
		releases: {},
		packages: {},
	}));

	yield* Console.log(describeFleet(fleet, state, pins));
});
