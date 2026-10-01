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
	/**
	 * A password is asked twice and stored as its hash. A required secret is
	 * asked for the first time a machine that reads it is built; the others
	 * wait for aett secret set.
	 */
	readonly kind: "password" | "token";
	readonly required: boolean;
	/** Why a value can't be this secret, if it can't. */
	readonly invalid: (value: string) => Option.Option<string>;
}

/** The secrets the fleet's machines read. */
export const machineSecrets = (fleet: Fleet): ReadonlyArray<MachineSecret> => [
	{
		name: "tailscale/auth-key",
		readBy: (machine) => machine.tailscale,
		prompt: "Tailscale auth key (tskey-auth-…)",
		kind: "token",
		required: false,
		invalid: (value) =>
			/^tskey-\S+$/.test(value)
				? Option.none()
				: Option.some("Expected a Tailscale auth key such as tskey-auth-…"),
	},
	...Option.toArray(
		Option.map(fleet.user, (user): MachineSecret => ({
			name: `users/${user}`,
			readBy: (machine) => machine.home.length > 0,
			prompt: `Password for ${user}, which sudo asks for on every machine with a home`,
			kind: "password",
			required: true,
			invalid: (value) =>
				/^\P{Cc}+$/u.test(value) ? Option.none() : Option.some("Expected a password"),
		})),
	),
];
