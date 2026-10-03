import { Option, Result } from "effect";
import type { Fleet, Machine } from "./fleet.ts";
import type { State } from "./state.ts";

/** A declared machine one apply leaves out, and why. */
export interface Skipped {
	readonly name: string;
	readonly reason: string;
}

/** The machines one apply covers, bare metal before VMs, and the declared ones it leaves out. */
export interface Targets {
	readonly targets: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<Skipped>;
}

/**
 * Picks the machines `aett apply` covers: the named one, or else every
 * machine aett can apply to, hosts before their guests, and `local`, the Mac
 * aett runs on, last. That leaves out machines not installed yet, VMs whose
 * host isn't, other Macs, which apply to themselves, and machines that use
 * what aett can't build yet; naming one of them is an error. A target whose
 * declared disk encryption differs from how it was installed is an error too,
 * because its new system could not mount its disk.
 */
export const applyTargets = (
	fleet: Fleet,
	state: State,
	name: Option.Option<string>,
	local: Option.Option<string>,
) =>
	Result.flatMap(select(fleet, state, name, local), (selected) => {
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

// Why apply can't reach a machine, if it can't: as the reason a run skips it and the error naming it gives.
const blocker = (fleet: Fleet, machine: Machine, state: State, local: Option.Option<string>) => {
	const installed = (name: string) => state.machines.get(name)?.installed === true;

	if (machine.unsupported.length > 0) {
		const what = machine.unsupported.join(", ");

		return Option.some({
			reason: `uses what aett can't build yet: ${what}`,
			error: `${machine.name} uses what aett can't build yet: ${what}.`,
		});
	}

	if (machine.kind === "macos") {
		return Option.contains(local, machine.name)
			? Option.none()
			: Option.some({
					reason: "is a Mac, which applies to itself",
					error: `${machine.name} is a Mac. Run aett apply on it.`,
				});
	}

	if (Option.isSome(machine.vm)) {
		const { host } = machine.vm.value;
		const hostMachine = fleet.machines.find((declared) => declared.name === host);

		return installed(host) && hostMachine?.unsupported.length === 0
			? Option.none()
			: Option.some({
					reason: `runs on ${host}, which aett can't apply yet`,
					error: `${machine.name} runs on ${host}, which aett can't apply yet. Apply ${host} first.`,
				});
	}

	return installed(machine.name)
		? Option.none()
		: Option.some({
				reason: "is not installed yet",
				error: `${machine.name} is not installed yet. Install it with aett machine install ${machine.name}.`,
			});
};

// The named machine, which must be one apply can reach, or else every such machine.
const select = (
	fleet: Fleet,
	state: State,
	name: Option.Option<string>,
	local: Option.Option<string>,
): Result.Result<Targets, string> => {
	if (Option.isNone(name)) {
		const checked = fleet.machines.map((machine) => ({
			machine,
			blocked: blocker(fleet, machine, state, local),
		}));

		const reachable = checked.flatMap(({ machine, blocked }) =>
			Option.isNone(blocked) ? [machine] : [],
		);

		return Result.succeed({
			targets: [
				...reachable.filter(({ vm, kind }) => Option.isNone(vm) && kind !== "macos"),
				...reachable.filter(({ vm }) => Option.isSome(vm)),
				...reachable.filter(({ kind }) => kind === "macos"),
			].map((machine) => machine.name),
			skipped: checked.flatMap(({ machine, blocked }) =>
				Option.isSome(blocked) ? [{ name: machine.name, reason: blocked.value.reason }] : [],
			),
		});
	}

	const machine = fleet.machines.find((declared) => declared.name === name.value);

	if (machine === undefined) {
		return Result.fail(`fleet.ts declares no machine named "${name.value}".`);
	}

	return Option.match(blocker(fleet, machine, state, local), {
		onNone: () => Result.succeed({ targets: [machine.name], skipped: [] }),
		onSome: ({ error }) => Result.fail(error),
	});
};
