import { Option } from "effect";
import type { Fleet, Machine } from "./fleet.ts";

/**
 * A secret machines read at runtime. It lives in secrets/<name>.json,
 * encrypted to the operators and to every machine that reads it, and the
 * operator sets it with aett secret set <name>.
 */
export interface MachineSecret {
	readonly name: string;
	readonly readBy: (machine: Machine) => boolean;
	/** What aett secret set asks for. */
	readonly prompt: string;
	/** Why a value can't be this secret, if it can't. */
	readonly invalid: (value: string) => Option.Option<string>;
}

/** The secrets the fleet's machines read. */
export const machineSecrets = (_fleet: Fleet): ReadonlyArray<MachineSecret> => [
	{
		name: "tailscale/auth-key",
		readBy: (machine) => machine.tailscale,
		prompt: "Tailscale auth key (tskey-auth-…)",
		invalid: (value) =>
			/^tskey-\S+$/.test(value)
				? Option.none()
				: Option.some("Expected a Tailscale auth key such as tskey-auth-…"),
	},
];
