import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { Prompt } from "effect/cli";
import { Ssh } from "../adapters/ssh.ts";
import { forgetHost } from "../domain/host.ts";
import { Engine } from "../engine/engine.ts";
import { loadFleet, readState } from "./load.ts";

export class DestroyError extends Schema.TaggedError<DestroyError>()("DestroyError", {
	message: Schema.String,
}) {}

/**
 * Deletes a VM that fleet.ts no longer declares and that its host has
 * stopped: its state volume and identity on the host, then its secrets, its
 * state and its known_hosts entry in the fleet. Asks for the name first
 * unless `yes`.
 */
export const destroy = Effect.fn("destroy")(function* (
	root: string,
	name: string,
	options: { readonly yes: boolean },
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const engine = yield* Engine;
	const ssh = yield* Ssh;
	const fleet = yield* loadFleet(root);

	if (fleet.machines.some((machine) => machine.name === name)) {
		return yield* new DestroyError({
			message: `${name} is still in fleet.ts. Remove it there and apply its host, which stops it. Then destroy it.`,
		});
	}

	const host = (yield* readState(root, fleet)).machines.get(name)?.host;

	if (host === undefined) {
		return yield* new DestroyError({
			message: `State records no VM named ${name}. aett machine destroy deletes VMs that fleet.ts no longer declares.`,
		});
	}

	const knownHostsFile = path.join(root, "state", "known_hosts");

	yield* Console.log(`Connecting to ${host}…`);

	const connection = yield* ssh.machine(host, { name: `${host}.local`, port: 22 }, knownHostsFile);

	if ((yield* engine.guestState(connection, name)) === "running") {
		return yield* new DestroyError({
			message: `${name} still runs on ${host}. Apply ${host}, which stops it, then destroy it.`,
		});
	}

	if (!options.yes) {
		const typed = yield* Prompt.String({
			message: `Type "${name}" to delete its volume on ${host}, its secrets and its state:`,
		});

		if (typed !== name) {
			return yield* new DestroyError({
				message: `"${typed}" is not "${name}". Nothing was deleted.`,
			});
		}
	}

	yield* engine.removeGuest(connection, name);
	yield* fs.remove(path.join(root, "secrets", name), { recursive: true, force: true });
	yield* fs.remove(path.join(root, "state", name), { recursive: true, force: true });

	if (yield* fs.exists(knownHostsFile)) {
		yield* fs.writeFileString(
			knownHostsFile,
			forgetHost(yield* fs.readFileString(knownHostsFile), name),
		);
	}

	return yield* Console.log(
		`Destroyed ${name}. If it joined your tailnet, remove it in the Tailscale admin console too.`,
	);
}, Effect.scoped);
