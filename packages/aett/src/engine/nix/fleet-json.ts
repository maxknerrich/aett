import { Option } from "effect";
import type { Fleet, Machine } from "../../domain/fleet.ts";
import { bridgeAddress, guestInterface } from "../../domain/network.ts";
import type { State } from "../../domain/state.ts";

// Whether fleet.ts declares nothing for the machine that aett can't build yet.
const buildable = (machine: Machine) => machine.unsupported.length === 0;

// What every listed machine has.
const base = (machine: Machine) => ({
	role: machine.role,
	channel: machine.channel,
	packages: machine.packages,
});

/**
 * Builds fleet.json, the flake's view of the fleet. It lists only machines
 * Nix can evaluate and that declare nothing aett can't build yet: bare-metal
 * machines with their facts and install disk recorded, and VMs whose host is
 * listed and whose address is recorded. A listed host names its guests and
 * its bridge address.
 */
export const fleetJson = (fleet: Fleet, state: State) => {
	const metal = fleet.machines.filter((machine) => {
		const recorded = state.machines.get(machine.name);

		return (
			buildable(machine) &&
			machine.kind === "nixos" &&
			recorded?.facts === true &&
			recorded.disk !== undefined
		);
	});

	const hosts = new Set(metal.map(({ name }) => name));

	const guests = fleet.machines.flatMap((machine) => {
		const recorded = state.machines.get(machine.name);

		const vm = Option.filter(
			machine.vm,
			({ host }) => buildable(machine) && hosts.has(host) && recorded?.host === host,
		);

		const network = Option.flatMap(Option.fromUndefinedOr(recorded?.address), guestInterface);

		return Option.toArray(
			Option.zipWith(vm, network, (settings, { address, ...link }) => ({
				machine,
				vm: { ...settings, address, ...link },
			})),
		);
	});

	return {
		operator: { sshKeys: state.operator.sshKeys },
		machines: Object.fromEntries([
			...metal.map((machine) => {
				const recorded = state.machines.get(machine.name);

				const own = guests
					.filter(({ vm }) => vm.host === machine.name)
					.map((guest) => guest.machine.name);

				const network = bridgeAddress(recorded?.subnet).pipe(
					Option.filter(() => own.length > 0),
					Option.map((bridge) => ({ guests: own, network: bridge })),
					Option.getOrElse(() => ({})),
				);

				return [
					machine.name,
					{
						...base(machine),
						disk: { device: recorded?.disk ?? "", encrypted: machine.encrypted },
						...network,
					},
				] as const;
			}),
			...guests.map(({ machine, vm }) => [machine.name, { ...base(machine), vm }] as const),
		]),
	};
};
