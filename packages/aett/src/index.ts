import type { Fleet, Machine } from "./domain/fleet.ts";

export type { Channel, Fleet, Machine, Role } from "./domain/fleet.ts";

/** Everything a machine declares besides its name. */
export type MachineOptions = Omit<Machine, "name">;

/**
 * Declares the fleet; fleet.ts default-exports the result.
 *
 * ```ts
 * export default fleet({ machines: [machine("box", { role: "hypervisor" })] })
 * ```
 */
export const fleet = (declaration: Fleet): Fleet => declaration;

/** Declares a machine by its hostname and role, with optional packages, channel and disk options. */
export const machine = (name: string, options: MachineOptions): Machine => ({ name, ...options });
