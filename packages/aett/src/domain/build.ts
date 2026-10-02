import { Option } from "effect";
import type { Fleet } from "./fleet.ts";
import type { State } from "./state.ts";

/**
 * The machines a build covers: bare-metal NixOS machines with their facts and
 * install disk recorded, and VMs placed on one of them with their address
 * recorded, none declaring what aett can't build yet.
 */
export const buildable = (fleet: Fleet, state: State): ReadonlySet<string> => {
	const supported = fleet.machines.filter(({ unsupported }) => unsupported.length === 0);

	const metal = new Set(
		supported.flatMap(({ name, kind }) => {
			const recorded = state.machines.get(name);

			return kind === "nixos" && recorded?.facts === true && recorded.disk !== undefined
				? [name]
				: [];
		}),
	);

	const guests = supported.flatMap(({ name, vm }) => {
		const recorded = state.machines.get(name);

		return Option.exists(
			vm,
			({ host }) => metal.has(host) && recorded?.host === host && recorded.address !== undefined,
		)
			? [name]
			: [];
	});

	return new Set([...metal, ...guests]);
};
