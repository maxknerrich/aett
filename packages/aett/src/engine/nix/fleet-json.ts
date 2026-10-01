import { Option } from "effect";
import type { Fleet, Machine } from "../../domain/fleet.ts";
import { bridgeAddress, guestInterface } from "../../domain/network.ts";
import type { State } from "../../domain/state.ts";

// Whether fleet.ts declares nothing for the machine that aett can't build yet.
const buildable = (machine: Machine) => machine.unsupported.length === 0;

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

		const forwards = Option.getOrNull(
			Option.map(Option.fromUndefinedOr(recorded?.forwards), ({ ssh, mosh }) => ({
				ssh,
				mosh: { from: mosh[0], to: mosh[1] },
			})),
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
