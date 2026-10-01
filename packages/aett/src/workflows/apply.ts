import { Console, Effect, Option, Path, Schema } from "effect";
import { Prompt } from "effect/cli";
import { Ssh } from "../adapters/ssh.ts";
import { applyTargets } from "../domain/apply.ts";
import { guestsOf } from "../domain/fleet.ts";
import { formatHost, type Host } from "../domain/host.ts";
import { type Build, Engine } from "../engine/engine.ts";
import { emit } from "./compile.ts";
import { placeGuestKeys } from "./identity.ts";

export class ApplyError extends Schema.TaggedError<ApplyError>()("ApplyError", {
	message: Schema.String,
}) {}

/** The answers `aett apply` takes as flags. */
export interface ApplyOptions {
	readonly host: Option.Option<Host>;
	readonly yes: boolean;
}

/**
 * Brings installed machines to their declared systems: the named one, or else
 * every installed machine. Everything is evaluated before any machine is
 * contacted, and the first machine that fails stops the run.
 */
export const apply = Effect.fn("apply")(function* (
	root: string,
	name: Option.Option<string>,
	options: ApplyOptions,
) {
	const engine = yield* Engine;

	if (Option.isSome(options.host) && Option.isNone(name)) {
		return yield* new ApplyError({
			message:
				"--host names one machine's address. Pass the machine too: aett apply <name> --host …",
		});
	}

	const { build, fleet, state } = yield* emit(root);

	const { targets, skipped } = yield* Effect.fromResult(applyTargets(fleet, state, name)).pipe(
		Effect.mapError((message) => new ApplyError({ message })),
	);

	yield* Effect.forEach(skipped, ({ name: machine, reason }) =>
		Console.log(`${machine} ${reason}, skipping it.`),
	);

	yield* Effect.forEach(targets, (machine) =>
		Console.log(`Evaluating ${machine}…`).pipe(Effect.andThen(engine.evaluate(build, machine))),
	);

	return yield* Effect.forEach(
		targets,
		(machine) =>
			applyTo(
				root,
				build,
				machine,
				Option.getOrElse(options.host, () => ({ name: `${machine}.local`, port: 22 })),
				{
					yes: options.yes,
					guests: guestsOf(fleet, machine).filter((guest) => build.machines.includes(guest)),
					recipients: state.operator.ageKeys,
				},
			),
		{ discard: true },
	);
});

// Builds the machine's system on it and, once the operator agrees, switches to it. A host's
// guests get their host keys first, so the ones the switch starts find their identity.
const applyTo = Effect.fn("applyTo")(function* (
	root: string,
	build: Build,
	name: string,
	host: Host,
	options: {
		readonly yes: boolean;
		readonly guests: ReadonlyArray<string>;
		readonly recipients: ReadonlyArray<string>;
	},
) {
	const engine = yield* Engine;
	const ssh = yield* Ssh;
	const path = yield* Path.Path;

	yield* Console.log(`Connecting to ${name} at ${formatHost(host)}…`);

	const connection = yield* ssh.machine(name, host, path.join(root, "state", "known_hosts"));

	yield* placeGuestKeys(root, connection, options.guests, options.recipients);

	const system = yield* engine.buildSystem(build, name, connection);

	if (system === (yield* engine.currentSystem(connection))) {
		return yield* Console.log(`${name} is up to date.`);
	}

	const changes = yield* engine.changes(connection, system);

	yield* Console.log(
		changes === ""
			? `${name}'s new system changes no package versions.`
			: `Changes on ${name}:\n${changes}`,
	);

	if (!options.yes && !(yield* Prompt.Confirm({ message: `Switch ${name} to the new system?` }))) {
		return yield* Console.log(`Left ${name} as it is.`);
	}

	yield* Console.log(`Switching ${name}…`);
	yield* engine.activate(connection, system);

	return yield* Console.log(`Switched ${name} to ${system}.`);
}, Effect.scoped);
