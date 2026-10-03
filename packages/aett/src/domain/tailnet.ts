import type { Fleet } from "./fleet.ts";
import type { Grant } from "./plugin.ts";

/** The tag a machine joins the tailnet with: its role's. */
export const tagOf = (role: string) => `tag:${role}`;

/** The tag an encrypted machine's initrd joins the tailnet with, which the policy should grant nothing. */
export const unlockTag = "tag:unlock";

// The tags of the named machines, Macs left out: they join as their owner's devices.
const tagsOf = (fleet: Fleet, names: ReadonlyArray<string>) =>
	[
		...new Set(
			fleet.machines.flatMap(({ name, role, kind }) =>
				names.includes(name) && kind !== "macos" ? [tagOf(role)] : [],
			),
		),
	].toSorted();

/**
 * The grants the tailnet's policy needs so each plugin's clients and
 * instances reach its instances' endpoints, by tag: one per plugin that has
 * endpoints. The policy stays its owner's; aett only says what to add.
 */
export const grantsFor = (fleet: Fleet): ReadonlyArray<Grant> =>
	[...fleet.services.values()].flatMap(({ plugin, instances, clients }) => {
		const ip = Object.values(plugin.endpoints ?? {}).map(({ port }) => `tcp:${port}`);
		const src = tagsOf(fleet, [...instances, ...clients]);
		const dst = tagsOf(fleet, instances);

		return ip.length === 0 || src.length === 0 || dst.length === 0 ? [] : [{ src, dst, ip }];
	});
