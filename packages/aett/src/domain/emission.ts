import { type Fleet, isEncrypted } from "./fleet.ts";
import type { State } from "./state.ts";

/**
 * Builds fleet.json, the flake's view of the fleet. It lists only machines
 * Nix can evaluate: facts and install disk both recorded in state.
 */
export const fleetJson = (fleet: Fleet, state: State) => ({
	operator: { sshKeys: state.operator.sshKeys },
	machines: Object.fromEntries(
		fleet.machines.flatMap((machine) => {
			const recorded = state.machines.get(machine.name);

			if (recorded?.facts !== true || recorded.disk === undefined) return [];

			const emitted = {
				role: machine.role,
				channel: machine.channel ?? "stable",
				packages: machine.packages ?? [],
				disk: { device: recorded.disk, encrypted: isEncrypted(machine) },
			};

			return [[machine.name, emitted] as const];
		}),
	),
});
