import { Option } from "effect";
import type { Fleet, Machine } from "../../domain/fleet.ts";
import { buildable } from "../../domain/build.ts";
import { bridgeAddress, guestInterface } from "../../domain/network.ts";
import type { State } from "../../domain/state.ts";

// What every listed machine has: its settings, Tailscale, and the fleet's user when it has a home.
// `secrets` are the machine secrets the fleet has.
const base = (fleet: Fleet, machine: Machine, secrets: ReadonlyArray<string>) => ({
	role: machine.role,
	channel: machine.channel,
	packages: machine.packages,
	tailscale: machine.tailscale
		? { tag: `tag:${machine.role}`, authKey: secrets.includes("tailscale/auth-key") }
		: null,
	user: fleet.user.pipe(
		Option.filter(() => machine.home.length > 0),
		Option.map((name) => ({ name, password: secrets.includes(`users/${name}`) })),
		Option.getOrNull,
	),
});

/**
 * Builds fleet.json, the flake's view of the fleet. It lists only machines
 * Nix can evaluate and that declare nothing aett can't build yet: bare-metal
 * machines with their facts and install disk recorded, and VMs whose host is
 * listed and whose address is recorded. A listed host names its guests, its
 * bridge address and the ports it forwards to guests with a home.
 */
export const fleetJson = (fleet: Fleet, state: State, secrets: ReadonlyArray<string>) => {
	const included = buildable(fleet, state);
	const metal = fleet.machines.filter(({ name, vm }) => included.has(name) && Option.isNone(vm));

	const guests = fleet.machines.flatMap((machine) => {
		const recorded = state.machines.get(machine.name);
		const vm = Option.filter(machine.vm, () => included.has(machine.name));
		const network = Option.flatMap(Option.fromUndefinedOr(recorded?.address), guestInterface);

		// Only a guest with a home is reached from the LAN; the ports stay reserved in state without one.
		const forwards = Option.fromUndefinedOr(recorded?.forwards).pipe(
			Option.filter(() => machine.home.length > 0),
			Option.map(({ ssh, mosh }) => ({ ssh, mosh: { from: mosh[0], to: mosh[1] } })),
			Option.getOrNull,
		);

		return Option.toArray(
			Option.zipWith(vm, network, (settings, { address, ...link }) => ({
				machine,
				vm: { ...settings, address, ...link, forwards },
			})),
		);
	});

	return {
		operator: { sshKeys: state.operator.sshKeys },
		machines: Object.fromEntries([
			...metal.map((machine) => {
				const recorded = state.machines.get(machine.name);

				const own = guests.filter(({ vm }) => vm.host === machine.name);

				const network = bridgeAddress(recorded?.subnet).pipe(
					Option.filter(() => own.length > 0),
					Option.map((bridge) => ({
						guests: own.map((guest) => guest.machine.name),
						network: bridge,
						forwards: own.flatMap(({ vm }) =>
							vm.forwards === null ? [] : [{ address: vm.address, ...vm.forwards }],
						),
					})),
					Option.getOrElse(() => ({})),
				);

				return [
					machine.name,
					{
						...base(fleet, machine, secrets),
						disk: { device: recorded?.disk ?? "", encrypted: machine.encrypted },
						...network,
					},
				] as const;
			}),
			...guests.map(
				({ machine, vm }) => [machine.name, { ...base(fleet, machine, secrets), vm }] as const,
			),
		]),
	};
};
