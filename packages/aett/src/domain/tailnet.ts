import type { Fleet } from "./fleet.ts";
import type { Grant } from "./plugin.ts";
import type { State } from "./state.ts";

/** The tag a machine joins the tailnet with: its role's. */
export const tagOf = (role: string) => `tag:${role}`;

/** The OAuth client's tag, which owns every tag aett gives machines, so the client may mint them one at a time. */
export const ownerTag = "tag:aett";

/** The tag an encrypted machine's initrd joins the tailnet with, which the policy should grant nothing. */
export const unlockTag = "tag:unlock";

// The tags of the named machines. A Mac that runs the Tailscale app is its owner's device and has none.
const tagsOf = (fleet: Fleet, state: State, names: ReadonlyArray<string>) =>
	[
		...new Set(
			fleet.machines.flatMap(({ name, role }) =>
				names.includes(name) && state.machines.get(name)?.tailscaleApp !== true
					? [tagOf(role)]
					: [],
			),
		),
	].toSorted();

/**
 * The grants the tailnet's policy needs so each plugin's clients and
 * instances reach its instances' endpoints, by tag: one per plugin that has
 * endpoints. The policy stays its owner's; aett only says what to add.
 */
export const grantsFor = (fleet: Fleet, state: State): ReadonlyArray<Grant> =>
	[...fleet.services.values()].flatMap(({ plugin, instances, clients }) => {
		const ip = Object.values(plugin.endpoints ?? {}).map(({ port }) => `tcp:${port}`);
		const src = tagsOf(fleet, state, [...instances, ...clients]);
		const dst = tagsOf(fleet, state, instances);

		return ip.length === 0 || src.length === 0 || dst.length === 0 ? [] : [{ src, dst, ip }];
	});
