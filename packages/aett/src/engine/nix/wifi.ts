import { pbkdf2Sync } from "node:crypto";

// A GKeyFile value with its escapes undone: \s, \t, \n, \r and \\.
const unescape = (value: string) =>
	value.replaceAll(
		/\\([stnr\\])/g,
		(_, escape: string) => ({ s: " ", t: "\t", n: "\n", r: "\r", "\\": "\\" })[escape] ?? escape,
	);

// The keyfile's keys by section, such as wifi.ssid.
const parse = (keyfile: string) => {
	const values = new Map<string, string>();

	keyfile.split("\n").reduce((section, line) => {
		const header = /^\[(.+)\]\s*$/.exec(line);

		if (header?.[1] !== undefined) return header[1];

		const equals = line.indexOf("=");

		if (equals > 0 && !line.startsWith("#")) {
			values.set(`${section}.${line.slice(0, equals).trim()}`, line.slice(equals + 1));
		}

		return section;
	}, "");

	return values;
};

// An SSID's bytes: NetworkManager writes a byte list like "104;111;" or an escaped string.
const ssidBytes = (value: string) =>
	/^(\d{1,3};)+$/.test(value)
		? Buffer.from(
				value
					.split(";")
					.filter((byte) => byte !== "")
					.map(Number),
			)
		: Buffer.from(unescape(value), "utf8");

/**
 * wpa_supplicant's configuration for the Wi-Fi networks in NetworkManager's
 * keyfiles: each SSID in hex and each passphrase as the PSK it derives, so no
 * value needs quoting. Open networks join without a key. A WPA3 network
 * joins through WPA2 with the same passphrase, which an access point in
 * transition mode allows; one that only speaks WPA3, and enterprise Wi-Fi,
 * are left to the console.
 */
export const wpaSupplicant = (keyfiles: ReadonlyArray<string>) =>
	keyfiles
		.map(parse)
		.flatMap((values) => {
			const ssid = values.get("wifi.ssid");

			if (values.get("connection.type") !== "wifi" || ssid === undefined) return [];

			const bytes = ssidBytes(ssid);
			const management = values.get("wifi-security.key-mgmt");
			const passphrase = values.get("wifi-security.psk");

			// A hidden network answers only when asked for by name.
			const network = `ssid=${bytes.toString("hex")}${values.get("wifi.hidden") === "true" ? "\n\tscan_ssid=1" : ""}`;

			if (management === undefined) return [`network={\n\t${network}\n\tkey_mgmt=NONE\n}\n`];

			if (!["wpa-psk", "sae"].includes(management) || passphrase === undefined) return [];

			const raw = unescape(passphrase);

			const psk = /^[0-9a-fA-F]{64}$/.test(raw)
				? raw.toLowerCase()
				: pbkdf2Sync(raw, bytes, 4096, 32, "sha1").toString("hex");

			return [`network={\n\t${network}\n\tpsk=${psk}\n\tkey_mgmt=WPA-PSK\n}\n`];
		})
		.join("");
