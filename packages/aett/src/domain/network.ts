import { Option, Result } from "effect";
import type { Fleet } from "./fleet.ts";
import type { MachineRecord, State } from "./state.ts";

// Guest networks: each machine that runs VMs gets one bridge with the subnet
// 10.100.<n>.0/24, n unique in the fleet. The host is .1 and its guests get
// fixed addresses from .2 up.

const subnetPattern = /^10\.100\.(\d{1,3})\.0\/24$/;

const addressPattern = /^10\.100\.(\d{1,3})\.(\d{1,3})$/;

// The n of a recorded 10.100.<n>.0/24.
const subnetIndex = (subnet: string | undefined) =>
	Option.map(Option.fromNullOr(subnetPattern.exec(subnet ?? "")), (match) => Number(match[1]));

// The two numbers of a recorded guest address 10.100.<n>.<k>.
const addressParts = (address: string) =>
	Option.map(Option.fromNullOr(addressPattern.exec(address)), (match) => ({
		subnet: Number(match[1]),
		guest: Number(match[2]),
	}));

// The first number from `from` to 254 that `taken` lacks.
const firstFree = (from: number, taken: ReadonlySet<number>) =>
	Option.fromUndefinedOr(
		Array.from({ length: 255 - from }, (_, index) => from + index).find(
			(candidate) => !taken.has(candidate),
		),
	);

/**
 * What state still lacks for the fleet's VMs: a subnet for each machine that
 * runs one, a host and an address on its subnet for each VM, and for a VM with
 * a home the ports its host forwards to its SSH and mosh. Earlier choices
 * stay, and guests that state still records keep their addresses until they
 * are destroyed, declared or not. Returns the fields to add to each machine's
 * record.
 */
export const allocate = (
	fleet: Fleet,
	state: State,
): Result.Result<ReadonlyMap<string, MachineRecord>, string> => {
	const records = [...state.machines];

	const vms = fleet.machines
		.flatMap(({ name, vm, home }) =>
			Option.toArray(Option.map(vm, ({ host }) => ({ name, host, home: home.length > 0 }))),
		)
		.toSorted((a, b) => a.name.localeCompare(b.name));

	const moved = vms.find(({ name, host }) => {
		const recorded = state.machines.get(name)?.host;

		return recorded !== undefined && recorded !== host;
	});

	if (moved !== undefined) {
		const from = state.machines.get(moved.name)?.host ?? "";

		return Result.fail(
			`${moved.name} runs on ${from}, but fleet.ts now puts it on ${moved.host}. aett can't move a VM yet: remove it from fleet.ts, apply ${from}, run aett machine destroy ${moved.name}, then declare it on ${moved.host}.`,
		);
	}

	const changes = new Map<string, MachineRecord>();

	const subnets = new Map(
		records.flatMap(([name, { subnet }]) =>
			Option.toArray(Option.map(subnetIndex(subnet), (index) => [name, index] as const)),
		),
	);

	for (const host of [...new Set(vms.map((vm) => vm.host))].toSorted()) {
		if (subnets.has(host)) continue;

		const index = firstFree(1, new Set(subnets.values()));

		if (Option.isNone(index)) {
			return Result.fail(
				`No guest subnet is left for ${host}: 10.100.1.0/24 to 10.100.254.0/24 are taken.`,
			);
		}

		subnets.set(host, index.value);
		changes.set(host, { subnet: `10.100.${index.value}.0/24` });
	}

	// Guest numbers in use per host, from state and from what this run hands out.
	const used = new Map<string, Set<number>>();

	const take = (host: string, guest: number) =>
		used.set(host, (used.get(host) ?? new Set()).add(guest));

	for (const [, { host, address }] of records) {
		const parts = addressParts(address ?? "");

		if (host !== undefined && Option.isSome(parts)) take(host, parts.value.guest);
	}

	for (const vm of vms) {
		const recorded = state.machines.get(vm.name);
		let placed = { host: vm.host, address: recorded?.address ?? "" };

		if (recorded?.address === undefined) {
			const guest = firstFree(2, used.get(vm.host) ?? new Set());

			if (Option.isNone(guest))
				return Result.fail(`${vm.host} has no free guest address left for ${vm.name}.`);

			take(vm.host, guest.value);
			placed = { host: vm.host, address: `10.100.${subnets.get(vm.host) ?? 0}.${guest.value}` };
			changes.set(vm.name, placed);
		}

		const parts = addressParts(placed.address);

		if (vm.home && recorded?.forwards === undefined && Option.isSome(parts)) {
			const forwards = forwardsFor(parts.value.guest);

			changes.set(
				vm.name,
				recorded?.address === undefined ? { ...placed, forwards } : { forwards },
			);
		}
	}

	return Result.succeed(changes);
};

// The host ports that reach the guest numbered `guest` on its host's subnet: one for SSH and ten
// for mosh. Unique per host, and clear of the host's own mosh ports, 60000 to 61000.
const forwardsFor = (guest: number) => ({
	ssh: 2200 + guest,
	mosh: [61000 + (guest - 2) * 10, 61000 + (guest - 2) * 10 + 9] as const,
});

/** How a guest sits on its host's bridge, derived from its recorded address. */
export interface GuestInterface {
	readonly address: string;
	readonly prefixLength: number;
	/** The host's address on the bridge. */
	readonly gateway: string;
	/** A locally administered MAC built from the address. */
	readonly mac: string;
	/** The host's tap device, at most 15 characters as Linux requires. */
	readonly tap: string;
}

const hex = (value: number) => value.toString(16).padStart(2, "0");

/** The interface of the guest at `address`, if it is an address aett hands out. */
export const guestInterface = (address: string): Option.Option<GuestInterface> =>
	Option.map(addressParts(address), ({ subnet, guest }) => ({
		address,
		prefixLength: 24,
		gateway: `10.100.${subnet}.1`,
		mac: `02:00:0a:64:${hex(subnet)}:${hex(guest)}`,
		tap: `vm-${guest}`,
	}));

/** The bridge address of the host whose recorded subnet is `subnet`, if it is one aett hands out. */
export const bridgeAddress = (subnet: string | undefined) =>
	Option.map(subnetIndex(subnet), (index) => ({ address: `10.100.${index}.1`, prefixLength: 24 }));

/**
 * state/ssh_config: a Host block per guest with a home, which reaches its SSH
 * through the port its host forwards on the LAN and checks its key against
 * aett's known hosts at `knownHosts`. The operator includes it from
 * ~/.ssh/config. Empty when no guest has a home.
 */
export const sshConfig = (fleet: Fleet, state: State, knownHosts: string) => {
	const blocks = fleet.machines.flatMap(({ name, vm }) => {
		const recorded = state.machines.get(name);

		return Option.toArray(
			Option.all({
				user: fleet.user,
				host: Option.map(vm, ({ host }) => host),
				forwards: Option.fromUndefinedOr(recorded?.forwards),
			}),
		).map(({ user, host, forwards }) =>
			[
				`Host ${name}`,
				`\tHostName ${host}.local`,
				`\tPort ${forwards.ssh}`,
				`\tUser ${user}`,
				`\tHostKeyAlias ${name}`,
				`\tUserKnownHostsFile "${knownHosts}"`,
			].join("\n"),
		);
	});

	return blocks.length === 0
		? ""
		: `# Written by aett: the fleet's VMs through their hosts' forwards. Include it from ~/.ssh/config.\n\n${blocks.join("\n\n")}\n`;
};
