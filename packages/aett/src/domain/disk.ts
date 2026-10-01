import { Option } from "effect";
import { isEncrypted, type Machine } from "./fleet.ts";

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
		`└─ 2  root  rest   btrfs${isEncrypted(machine) ? "  inside LUKS" : ""}`,
		"      ├─ @nix      /nix",
		"      └─ @persist  /persist",
		"/     tmpfs, capped at 1 GB, empty on every boot",
	].join("\n");

/**
 * Whether a disk passphrase can be typed at the console and survives disko,
 * which passes it through `echo -n`: not empty, no control characters (the
 * console treats them as line editing), and nothing echo would take for its
 * own options.
 */
export const isPassphrase = (value: string) => /^\P{Cc}+$/u.test(value) && !/^-[neE]+$/.test(value);
