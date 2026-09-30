import { Option, Schema } from "effect";
import { isEncrypted, type Machine } from "./fleet.ts";

/** The part of a nixos-facter report that disk selection reads. */
export const FacterReport = Schema.Struct({
	hardware: Schema.Struct({
		disk: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					class_list: Schema.optionalKey(Schema.Array(Schema.String)),
					model: Schema.optionalKey(Schema.String),
					unix_device_names: Schema.optionalKey(Schema.Array(Schema.String)),
					resources: Schema.optionalKey(
						Schema.Array(
							Schema.Struct({
								type: Schema.String,
								unit: Schema.optionalKey(Schema.String),
								value_1: Schema.optionalKey(Schema.Number),
								value_2: Schema.optionalKey(Schema.Number),
							}),
						),
					),
				}),
			),
		),
	}),
});

export interface FacterReport extends Schema.Schema.Type<typeof FacterReport> {}

type FacterDisk = NonNullable<FacterReport["hardware"]["disk"]>[number];

/** A disk aett can install to. */
export interface Disk {
	readonly model: string;
	/** The /dev/disk/by-id/ path state records and disko uses. */
	readonly byId: string;
	readonly bytes: number;
	/** Every device name the report lists, any of which `--disk` accepts. */
	readonly names: ReadonlyArray<string>;
}

const byIdDirectory = "/dev/disk/by-id/";

// Links built from transport identifiers rather than model and serial.
const opaqueLinks = ["wwn-", "nvme-eui.", "nvme-nvme."];

/**
 * Picks the disk's stable path: the shortest by-id link named after model and
 * serial, else the shortest by-id link of any kind.
 */
export const byIdPath = (names: ReadonlyArray<string>): Option.Option<string> => {
	const links = names
		.filter((name) => name.startsWith(byIdDirectory))
		.toSorted((a, b) => a.length - b.length);

	const readable = links.find(
		(link) => !opaqueLinks.some((prefix) => link.startsWith(byIdDirectory + prefix)),
	);

	return Option.fromUndefinedOr(readable ?? links[0]);
};

/** The disk's size in bytes, from its sector count and sector size. */
export const diskBytes = (disk: FacterDisk) => {
	const size = disk.resources?.find(({ type, unit }) => type === "size" && unit === "sectors");

	return (size?.value_1 ?? 0) * (size?.value_2 ?? 0);
};

/** The disks aett may install to: everything not attached over USB that has a by-id link. */
export const internalDisks = (report: FacterReport): ReadonlyArray<Disk> =>
	(report.hardware.disk ?? []).flatMap((disk) => {
		const names = disk.unix_device_names ?? [];

		if (disk.class_list?.includes("usb") === true) return [];

		return Option.match(byIdPath(names), {
			onNone: () => [],
			onSome: (byId) => [
				{ model: disk.model ?? "Unknown disk", byId, bytes: diskBytes(disk), names },
			],
		});
	});

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
 * which passes it through `echo -n`: one line without control characters, and
 * nothing echo would take for its own options.
 */
export const isPassphrase = (value: string) =>
	/^[^\r\n\0]+$/.test(value) && !/^-[neE]+$/.test(value);
