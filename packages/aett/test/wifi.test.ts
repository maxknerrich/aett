import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { wpaSupplicant } from "../src/engine/nix/wifi.ts";

const keyfile = (lines: ReadonlyArray<string>) => lines.join("\n");

describe("wpaSupplicant", () => {
	it("writes each SSID in hex and each passphrase as its PSK, so no value needs quoting, under either section name", () => {
		const home = keyfile([
			"[connection]",
			"id=home",
			"type=wifi",
			"[wifi]",
			'ssid=My "Net"\\sx',
			"[wifi-security]",
			"key-mgmt=wpa-psk",
			'psk=pa\\\\ss"word',
		]);

		const cafe = keyfile([
			"[connection]",
			"type=wifi",
			"[wifi]",
			"ssid=99;97;102;101;",
			"hidden=true",
		]);

		const wired = keyfile(["[connection]", "type=ethernet"]);

		const office = keyfile([
			"[connection]",
			"type=wifi",
			"[wifi]",
			"ssid=corp",
			"[wifi-security]",
			"key-mgmt=wpa-eap",
		]);

		// The same network as home, under NetworkManager's canonical names.
		const canonical = keyfile([
			"[connection]",
			"type=802-11-wireless",
			"[802-11-wireless]",
			'ssid=My "Net"\\sx',
			"[802-11-wireless-security]",
			"key-mgmt=wpa-psk",
			'psk=pa\\\\ss"word',
		]);

		const ssid = Buffer.from('My "Net" x');
		const psk = pbkdf2Sync('pa\\ss"word', ssid, 4096, 32, "sha1").toString("hex");

		const protectedHome = `network={\n\tssid=${ssid.toString("hex")}\n\tpsk=${psk}\n\tkey_mgmt=WPA-PSK\n}\n`;

		expect(wpaSupplicant([home, cafe, wired, office, canonical])).toBe(
			[
				protectedHome,
				`network={\n\tssid=${Buffer.from("cafe").toString("hex")}\n\tscan_ssid=1\n\tkey_mgmt=NONE\n}\n`,
				protectedHome,
			].join(""),
		);
	});
});
