import { Option, Result } from "effect";
import type { Fleet } from "./fleet.ts";
import type { State } from "./state.ts";

/** The machines one apply covers, and the declared ones it leaves out. */
export interface Targets {
	readonly targets: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<string>;
}

/**
 * Picks the machines `aett apply` covers: the named one, which must be
 * installed, or else every installed machine. `skipped` lists the declared
 * machines left out because they are not installed yet.
 */
export const applyTargets = (
	fleet: Fleet,
	state: State,
	name: Option.Option<string>,
): Result.Result<Targets, string> => {
	const installed = (machine: string) => state.machines.get(machine)?.installed === true;

	if (Option.isNone(name)) {
		const names = fleet.machines.map((machine) => machine.name);

		return Result.succeed({
			targets: names.filter(installed),
			skipped: names.filter((machine) => !installed(machine)),
		});
	}

	if (!fleet.machines.some((machine) => machine.name === name.value)) {
		return Result.fail(`fleet.ts declares no machine named "${name.value}".`);
	}

	if (!installed(name.value)) {
		return Result.fail(
			`${name.value} is not installed yet. Install it with aett machine install ${name.value}.`,
		);
	}

	return Result.succeed({ targets: [name.value], skipped: [] });
};
