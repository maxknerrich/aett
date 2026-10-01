import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { findDisk } from "../src/domain/disk.ts";
import { byIdPath, type FacterReport, internalDisks } from "../src/engine/nix/facter.ts";

// Trimmed from a real report: an NVMe disk and the installer stick on USB.
const nvmeNames = [
	"/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_aett0001",
	"/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_aett0001_1",
	"/dev/disk/by-id/nvme-nvme.1b36-6165747430303031-51454d55204e564d65204374726c-00000001",
	"/dev/disk/by-path/pci-0000:00:01.0-nvme-1",
	"/dev/nvme0n1",
];

const report: FacterReport = {
	hardware: {
		disk: [
			{
				class_list: ["disk", "block_device", "nvme"],
				model: "QEMU NVMe Ctrl",
				unix_device_names: nvmeNames,
				resources: [
					{ type: "disk_geo" },
					{ type: "size", unit: "sectors", value_1: 67_108_864, value_2: 512 },
				],
			},
			{
				class_list: ["disk", "usb", "scsi", "block_device"],
				model: "QEMU HARDDISK",
				unix_device_names: [
					"/dev/disk/by-id/usb-QEMU_QEMU_HARDDISK_1-0000:00:03.0-2-0:0",
					"/dev/sda",
				],
				resources: [{ type: "size", unit: "sectors", value_1: 2_981_036, value_2: 512 }],
			},
			{ class_list: ["disk", "block_device"], model: "No links", unix_device_names: ["/dev/sdb"] },
		],
	},
};

describe("internalDisks", () => {
	it("offers disks not on USB that have a by-id link, with model and size", () => {
		expect(internalDisks(report)).toEqual([
			{
				model: "QEMU NVMe Ctrl",
				byId: "/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_aett0001",
				bytes: 34_359_738_368,
				names: nvmeNames,
			},
		]);
	});

	it("finds a disk by any of its device names", () => {
		const disks = internalDisks(report);

		expect(findDisk(disks, "/dev/nvme0n1")).toEqual(Option.some(disks[0]));
		expect(findDisk(disks, "/dev/sda")).toEqual(Option.none());
	});
});

describe("byIdPath", () => {
	it("prefers the shortest link named after model and serial", () => {
		expect(
			byIdPath([
				"/dev/disk/by-id/wwn-0x5002538e",
				"/dev/disk/by-id/nvme-eui.0025385",
				"/dev/disk/by-id/ata-Samsung_SSD_870_S5Y1NG0R_1",
				"/dev/disk/by-id/ata-Samsung_SSD_870_S5Y1NG0R",
				"/dev/sda",
			]),
		).toEqual(Option.some("/dev/disk/by-id/ata-Samsung_SSD_870_S5Y1NG0R"));
	});

	it("falls back to the shortest opaque link", () => {
		expect(
			byIdPath(["/dev/disk/by-id/nvme-eui.0025385b71b0a8a1", "/dev/disk/by-id/wwn-0x5002538e"]),
		).toEqual(Option.some("/dev/disk/by-id/wwn-0x5002538e"));
	});

	it("finds nothing without a by-id link", () => {
		expect(byIdPath(["/dev/disk/by-path/pci-0000:00:01.0-nvme-1", "/dev/nvme0n1"])).toEqual(
			Option.none(),
		);
	});
});
