import { Option, Result } from "effect";
import type { Fleet, Machine } from "./fleet.ts";
import type { State } from "./state.ts";

/** A declared machine one apply leaves out, and why. */
export interface Skipped {
	readonly name: string;
	readonly reason: string;
}

/** The machines one apply covers, and the declared ones it leaves out. */
export interface Targets {
	readonly targets: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<Skipped>;
}

/**
 * Picks the machines `aett apply` covers: the named one, or else every
 * machine aett can apply to. That leaves out machines not installed yet and
 * machines that use what aett can't build yet; naming one of them is an
 * error. A target whose declared disk encryption differs from how it was
 * installed is an error too, because its new system could not mount its disk.
 */
export const applyTargets = (fleet: Fleet, state: State, name: Option.Option<string>) =>
	Result.flatMap(select(fleet, state, name), (selected) => {
		const changed = fleet.machines.find(
			(machine) =>
				selected.targets.includes(machine.name) &&
				(state.machines.get(machine.name)?.encrypted ?? false) !== machine.encrypted,
		);

		if (changed === undefined) return Result.succeed(selected);

		const [was, now] = changed.encrypted
			? ["unencrypted", "encrypted"]
			: ["encrypted", "unencrypted"];

		return Result.fail(
			`${changed.name}'s disk was installed ${was}, but fleet.ts now declares it ${now}. Only a reinstall changes that: aett machine install ${changed.name} --reinstall.`,
		);
	});

// Why apply leaves a machine out, if it does.
const skipReason = (machine: Machine, state: State) => {
	if (machine.unsupported.length > 0) {
		return Option.some(`uses what aett can't build yet: ${machine.unsupported.join(", ")}`);
	}

	return state.machines.get(machine.name)?.installed === true
		? Option.none()
		: Option.some("is not installed yet");
};

// The named machine, which must be one apply can reach, or else every such machine.
const select = (
	fleet: Fleet,
	state: State,
	name: Option.Option<string>,
): Result.Result<Targets, string> => {
	if (Option.isNone(name)) {
		const checked = fleet.machines.map((machine) => ({
			machine,
			reason: skipReason(machine, state),
		}));

		return Result.succeed({
			targets: checked.flatMap(({ machine, reason }) =>
				Option.isNone(reason) ? [machine.name] : [],
			),
			skipped: checked.flatMap(({ machine, reason }) =>
				Option.isSome(reason) ? [{ name: machine.name, reason: reason.value }] : [],
			),
		});
	}

	const machine = fleet.machines.find((declared) => declared.name === name.value);

	if (machine === undefined) {
		return Result.fail(`fleet.ts declares no machine named "${name.value}".`);
	}

	if (machine.unsupported.length > 0) {
		return Result.fail(
			`${machine.name} uses what aett can't build yet: ${machine.unsupported.join(", ")}.`,
		);
	}

	if (state.machines.get(machine.name)?.installed !== true) {
		return Result.fail(
			`${machine.name} is not installed yet. Install it with aett machine install ${machine.name}.`,
		);
	}

	return Result.succeed({ targets: [machine.name], skipped: [] });
};
