import { describe, expect, it } from "vite-plus/test";
import { isPassphrase } from "../src/domain/disk.ts";

describe("isPassphrase", () => {
	it.each(["correct horse battery", "-x", "--n", "-n word"])("accepts %j", (value) => {
		expect(isPassphrase(value)).toBe(true);
	});

	// Control characters are line editing at the console; disko's `echo -n` swallows -n, -e and -E.
	it.each(["", "secret\r", "two\nlines", "nul\0", "tab\there", "del\x7f", "-n", "-e", "-neE"])(
		"rejects %j",
		(value) => {
			expect(isPassphrase(value)).toBe(false);
		},
	);
});
