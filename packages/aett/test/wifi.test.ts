import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { wpaSupplicant } from "../src/engine/nix/wifi.ts";

const keyfile = (lines: ReadonlyArray<string>) => lines.join("\n");

// One connection's profile, with `psk` as its password.
const profile = (psk: string) =>
	keyfile([
		"[connection]",
		"type=wifi",
		"uuid=5d1f1c2e-0000-4000-8000-000000000001",
		"[wifi]",
		"ssid=home",
		"[wifi-security]",
		"key-mgmt=wpa-psk",
		`psk=${psk}`,
	]);

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

	it("takes a connection's first profile, as NetworkManager lets a runtime one shadow a persistent one", () => {
		const runtime = pbkdf2Sync("new password", Buffer.from("home"), 4096, 32, "sha1").toString(
			"hex",
		);

		expect(wpaSupplicant([profile("new password"), profile("old password")])).toBe(
			`network={\n\tssid=${Buffer.from("home").toString("hex")}\n\tpsk=${runtime}\n\tkey_mgmt=WPA-PSK\n}\n`,
		);
	});
});
