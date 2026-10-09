import { Option } from "effect";
import type { Fleet, Machine } from "../../domain/fleet.ts";
import { buildable } from "../../domain/build.ts";
import { bridgeAddress, guestInterface } from "../../domain/network.ts";
import type { Source } from "../../domain/packages.ts";
import type { Pins } from "../../domain/pins.ts";
import { machineSecrets } from "../../domain/secrets.ts";
import type { State } from "../../domain/state.ts";

/** What a build carries besides fleet.ts and state: the secrets that exist and each certificate's fingerprint by secret. */
export interface Extras {
	readonly secrets: ReadonlyArray<string>;
	readonly fingerprints: ReadonlyMap<string, string>;
}

// A machine on the tailnet as state records it, or null before it joined.
const tailnetOf = (state: State, name: string) => {
	const recorded = state.machines.get(name);

	return recorded?.tailnet === undefined || recorded.tailnetName === undefined
		? null
		: { address: recorded.tailnet, name: recorded.tailnetName };
};

// Package names by the source the pins record for them; names without one yet are left out.
const bySource = (packages: ReadonlyArray<string>, pins: Pins) => {
	const of = (source: Source) => packages.filter((name) => pins.packages[name] === source);

	return { "llm-agents": of("llm-agents"), nixpkgs: of("nixpkgs"), unstable: of("unstable") };
};

// What every listed machine has: its settings, packages, secrets, services and the fleet's user.
const base = (fleet: Fleet, machine: Machine, state: State, extras: Extras, pins: Pins) => {
	const secrets = machineSecrets(fleet).filter(
		({ name, readers }) => readers.includes(machine.name) && extras.secrets.includes(name),
	);

	const services = machine.services.flatMap(({ name, instance }) =>
		Option.toArray(
			Option.map(Option.fromUndefinedOr(fleet.services.get(name)), (service) => ({
				name,
				instance,
				service,
			})),
		),
	);

	// The fingerprints of a plugin's certificates that every machine it configures sees, by peer.
	const fingerprints = (service: string, peer: string) =>
		Object.fromEntries(
			[...extras.fingerprints].flatMap(([secret, fingerprint]) => {
				const [owner, name, ...rest] = secret.split("/");

				return owner === service && name !== undefined && (rest.length === 0 || rest[0] === peer)
					? [[name, fingerprint] as const]
					: [];
			}),
		);

	const instanced = services.filter(({ instance }) => instance);

	return {
		role: machine.role,
		channel: machine.channel,
		packages: bySource(machine.packages, pins),
		releases: machine.releases.flatMap(({ github }) =>
			Option.toArray(
				Option.map(Option.fromUndefinedOr(pins.releases[github]), ({ bin, version, assets }) => ({
					bin,
					version,
					assets,
				})),
			),
		),
		apps: machine.apps,
		brews: machine.brews,
		tailnet: tailnetOf(state, machine.name),
		user: fleet.user.pipe(
			Option.filter(() => machine.user),
			Option.map((name) => ({ name, password: extras.secrets.includes(`users/${name}`) })),
			Option.getOrNull,
		),
		secrets: secrets.map(({ name, file }) => ({ name, file })),
		services: Object.fromEntries(
			services.map(({ name, instance, service }) => [
				name,
				{
					instance,
					options: service.options,
					peers: [...service.instances, ...service.clients].map((peer) => ({
						name: peer,
						instance: service.instances.includes(peer),
						tailnet: tailnetOf(state, peer),
						fingerprints: fingerprints(name, peer),
					})),
				},
			]),
		),
		state: instanced.flatMap(({ service }) =>
			Object.entries(service.plugin.state ?? {}).map(([path, { bulk }]) => ({
				path,
				bulk: bulk === true,
			})),
		),
		endpoints: instanced.flatMap(({ name, service }) =>
			Object.entries(service.plugin.endpoints ?? {}).map(([endpoint, { port, web }]) => ({
				service: name,
				name: endpoint,
				port,
				web: web === true,
			})),
		),
	};
};

/**
 * Builds fleet.json, the flake's view of the fleet. It lists only machines
 * Nix can evaluate and that declare nothing aett can't build yet: bare-metal
 * machines with their facts and disks recorded, Macs with their platform
 * recorded, and VMs whose host is listed and whose address is recorded. A
 * listed host names its guests, its bridge address and the ports it forwards
 * to guests with a home.
 */
export const fleetJson = (fleet: Fleet, state: State, extras: Extras, pins: Pins) => {
	const included = buildable(fleet, state);

	const metal = fleet.machines.filter(
		({ name, vm, kind }) => included.has(name) && Option.isNone(vm) && kind === "nixos",
	);

	const macs = fleet.machines.filter(({ name, kind }) => included.has(name) && kind === "macos");

	const guests = fleet.machines.flatMap((machine) => {
		const recorded = state.machines.get(machine.name);
		const vm = Option.filter(machine.vm, () => included.has(machine.name));
		const network = Option.flatMap(Option.fromUndefinedOr(recorded?.address), guestInterface);

		// Only a guest with a home is reached from the LAN; the ports stay reserved in state without one.
		const forwards = Option.fromUndefinedOr(recorded?.forwards).pipe(
			Option.filter(() => machine.user),
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

				const disks =
					machine.role === "nas"
						? { pools: recorded?.pools ?? { root: [], tank: [] } }
						: { disk: { device: recorded?.disk ?? "", encrypted: machine.encrypted } };

				// An encrypted machine's initrd answers on its LAN once install set it up.
				const unlock = machine.encrypted && recorded?.unlock !== undefined;

				return [
					machine.name,
					{
						...base(fleet, machine, state, extras, pins),
						...disks,
						unlock,
						...network,
					},
				] as const;
			}),
			...guests.map(
				({ machine, vm }) =>
					[machine.name, { ...base(fleet, machine, state, extras, pins), vm }] as const,
			),
			...macs.map(
				(machine) =>
					[
						machine.name,
						{
							...base(fleet, machine, state, extras, pins),
							darwin: {
								system: state.machines.get(machine.name)?.platform ?? "aarch64-darwin",
								determinate: state.machines.get(machine.name)?.determinate === true,
							},
							homebrew: { zap: state.machines.get(machine.name)?.zap === true },
						},
					] as const,
			),
		]),
	};
};
