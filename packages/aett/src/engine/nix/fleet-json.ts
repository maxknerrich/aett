import type { Fleet } from "../../domain/fleet.ts";
import type { State } from "../../domain/state.ts";

/**
 * Builds fleet.json, the flake's view of the fleet. It lists only machines
 * Nix can evaluate: facts and install disk both recorded in state, and nothing
 * declared that aett can't build yet.
 */
export const fleetJson = (fleet: Fleet, state: State) => ({
	operator: { sshKeys: state.operator.sshKeys },
	machines: Object.fromEntries(
		fleet.machines.flatMap((machine) => {
			const recorded = state.machines.get(machine.name);

			if (
				machine.unsupported.length > 0 ||
				recorded?.facts !== true ||
				recorded.disk === undefined
			) {
				return [];
			}

			const emitted = {
				role: machine.role,
				channel: machine.channel,
				packages: machine.packages,
				disk: { device: recorded.disk, encrypted: machine.encrypted },
			};

			return [[machine.name, emitted] as const];
		}),
	),
});
