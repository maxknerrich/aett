import { Option } from "effect";
import type { Machine } from "./fleet.ts";

/** A disk aett can install to, as the engine's hardware discovery reports it. */
export interface Disk {
	readonly model: string;
	/** The /dev/disk/by-id/ path that state records and install erases. */
	readonly byId: string;
	readonly bytes: number;
	/** Every device name the report lists, any of which `--disk` accepts. */
	readonly names: ReadonlyArray<string>;
}

/** Finds the disk a path names, by any of its device names. */
export const findDisk = (disks: ReadonlyArray<Disk>, path: string) =>
	Option.fromUndefinedOr(disks.find(({ names }) => names.includes(path)));

/** Shows a disk as the operator picks it: model, size and by-id path. */
export const diskLabel = ({ model, bytes, byId }: Disk) =>
	`${model} · ${Math.round(bytes / 1e9)} GB · ${byId}`;

/** The read-only layout preview install shows before it asks to erase the disk; it mirrors disk.nix. */
export const layoutPreview = (machine: Machine, disk: Disk) =>
	[
		`${machine.name} · ${disk.model} · ${disk.byId}`,
		"├─ 1  ESP   1 GB   vfat   /boot",
		`└─ 2  root  rest   btrfs${machine.encrypted ? "  inside LUKS" : ""}`,
		"      ├─ @nix      /nix",
		"      └─ @persist  /persist",
		"/     tmpfs, capped at 1 GB, empty on every boot",
	].join("\n");

/** The disks of a NAS's two pools. */
export interface Pools {
	readonly root: ReadonlyArray<Disk>;
	readonly tank: ReadonlyArray<Disk>;
}

/**
 * Why the disks chosen for a NAS's pools can't be them, if they can't: each
 * pool mirrors at least two disks, and no disk is in both.
 */
export const poolProblem = ({ root, tank }: Pools) => {
	if (root.length < 2) return Option.some("The root pool mirrors at least two disks.");

	if (tank.length < 2) return Option.some("The tank pool mirrors at least two disks.");

	const shared = root.find(({ byId }) => tank.some((disk) => disk.byId === byId));

	return Option.map(
		Option.fromUndefinedOr(shared),
		({ byId }) => `${byId} can't be in both pools.`,
	);
};

/** The read-only preview install shows for a NAS before it asks to erase the disks; it mirrors nas.nix. */
export const nasPreview = (machine: Machine, { root, tank }: Pools) =>
	[
		`${machine.name} · every disk inside LUKS, one passphrase for all`,
		"root  btrfs RAID1, an ESP on each disk",
		...root.map((disk) => `      ${diskLabel(disk)}`),
		"      ├─ @nix      /nix",
		"      └─ @persist  /persist",
		"tank  btrfs RAID1, /tank, where bulk state lands",
		...tank.map((disk) => `      ${diskLabel(disk)}`),
		"/     tmpfs, capped at 1 GB, empty on every boot",
	].join("\n");

/**
 * Whether a disk passphrase can be typed at the console and survives disko,
 * which passes it through `echo -n`: not empty, no control characters (the
 * console treats them as line editing), and nothing echo would take for its
 * own options.
 */
export const isPassphrase = (value: string) => /^\P{Cc}+$/u.test(value) && !/^-[neE]+$/.test(value);
