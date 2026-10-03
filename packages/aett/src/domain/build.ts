import { Option } from "effect";
import type { Fleet } from "./fleet.ts";
import type { State } from "./state.ts";

/**
 * The machines a build covers: bare-metal NixOS machines with their facts and
 * install disks recorded, Macs whose platform aett recorded, and VMs placed on
 * one of the metal machines with their address recorded, none declaring what
 * aett can't build yet.
 */
export const buildable = (fleet: Fleet, state: State): ReadonlySet<string> => {
	const supported = fleet.machines.filter(({ unsupported }) => unsupported.length === 0);

	const metal = new Set(
		supported.flatMap(({ name, kind, role }) => {
			const recorded = state.machines.get(name);

			const disks =
				role === "nas" ? (recorded?.pools?.root.length ?? 0) > 0 : recorded?.disk !== undefined;

			return kind === "nixos" && recorded?.facts === true && disks ? [name] : [];
		}),
	);

	const macs = supported.flatMap(({ name, kind }) =>
		kind === "macos" && state.machines.get(name)?.system !== undefined ? [name] : [],
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

	return new Set([...metal, ...macs, ...guests]);
};
