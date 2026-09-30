import { Option, Result } from "effect";
import { type Fleet, isEncrypted } from "./fleet.ts";
import type { State } from "./state.ts";

/** The machines one apply covers, and the declared ones it leaves out. */
export interface Targets {
	readonly targets: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<string>;
}

/**
 * Picks the machines `aett apply` covers: the named one, which must be
 * installed, or else every installed machine. `skipped` lists the declared
 * machines left out because they are not installed yet. A target whose
 * declared disk encryption differs from how it was installed is an error,
 * because its new system could not mount its disk.
 */
export const applyTargets = (fleet: Fleet, state: State, name: Option.Option<string>) =>
	Result.flatMap(select(fleet, state, name), (selected) => {
		const changed = fleet.machines.find(
			(machine) =>
				selected.targets.includes(machine.name) &&
				(state.machines.get(machine.name)?.encrypted ?? false) !== isEncrypted(machine),
		);

		if (changed === undefined) return Result.succeed(selected);

		const [was, now] = isEncrypted(changed)
			? ["unencrypted", "encrypted"]
			: ["encrypted", "unencrypted"];

		return Result.fail(
			`${changed.name}'s disk was installed ${was}, but fleet.ts now declares it ${now}. Only a reinstall changes that: aett machine install ${changed.name} --reinstall.`,
		);
	});

// The named machine, which must be installed, or else every installed machine.
const select = (
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
