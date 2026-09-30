import { Console, Effect, Option, Path, Schema } from "effect";
import { Prompt } from "effect/cli";
import { Nix } from "../adapters/nix.ts";
import { shellQuote, Ssh } from "../adapters/ssh.ts";
import { applyTargets } from "../domain/apply.ts";
import { formatHost, type Host } from "../domain/host.ts";
import { emit } from "./compile.ts";

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
	const nix = yield* Nix;

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

	yield* Effect.forEach(skipped, (machine) =>
		Console.log(`${machine} is not installed yet, skipping it.`),
	);

	yield* Effect.forEach(targets, (machine) =>
		Console.log(`Evaluating ${machine}…`).pipe(Effect.andThen(nix.evalDrv(build, machine))),
	);

	return yield* Effect.forEach(
		targets,
		(machine) =>
			applyTo(
				root,
				build,
				machine,
				Option.getOrElse(options.host, () => ({ name: `${machine}.local`, port: 22 })),
				options.yes,
			),
		{ discard: true },
	);
});

// Builds the machine's system on it and, once the operator agrees, switches to it.
const applyTo = Effect.fn("applyTo")(function* (
	root: string,
	build: string,
	name: string,
	host: Host,
	yes: boolean,
) {
	const nix = yield* Nix;
	const ssh = yield* Ssh;
	const path = yield* Path.Path;

	yield* Console.log(`Connecting to ${name} at ${formatHost(host)}…`);

	const connection = yield* ssh.machine(name, host, path.join(root, "state", "known_hosts"));

	yield* Console.log(`Copying aett's flake and its inputs to ${name}…`);

	const source = yield* nix.archive(build, connection);

	yield* Console.log(`Building the system on ${name}…`);

	const system = (yield* connection.stream(
		`nix build --no-link --print-out-paths ${shellQuote(`${source}#nixosConfigurations.${name}.config.system.build.toplevel`)}`,
	)).trim();

	const current = (yield* connection.run("readlink -f /run/current-system")).trim();

	if (system === current) return yield* Console.log(`${name} is up to date.`);

	const changes = (yield* connection.run(
		`nix store diff-closures /run/current-system ${shellQuote(system)}`,
	)).trim();

	yield* Console.log(
		changes === ""
			? `${name}'s new system changes no package versions.`
			: `Changes on ${name}:\n${changes}`,
	);

	if (!yes && !(yield* Prompt.Confirm({ message: `Switch ${name} to the new system?` }))) {
		return yield* Console.log(`Left ${name} as it is.`);
	}

	yield* Console.log(`Switching ${name}…`);
	yield* connection.run(`nix-env -p /nix/var/nix/profiles/system --set ${shellQuote(system)}`);

	// nixos-rebuild's invocation: a transient unit finishes the switch even if the connection drops.
	// Its output goes to stderr, which streams to the terminal.
	yield* connection.stream(
		[
			"systemd-run -E LOCALE_ARCHIVE -E NIXOS_INSTALL_BOOTLOADER --collect --no-ask-password",
			"--pipe --quiet --service-type=exec --unit=aett-switch-to-configuration --wait",
			shellQuote(`${system}/bin/switch-to-configuration`),
			"switch >&2",
		].join(" "),
	);

	return yield* Console.log(`Switched ${name} to ${system}.`);
}, Effect.scoped);
