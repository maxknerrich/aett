import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ageKeyPair } from "../src/domain/state.ts";

describe("ageKeyPair", () => {
	const publicKey = "age1gejw6jhjj3pdapugaevecrtsla2kcjhrdzykaznyh5xv4fjukuqq42qv3d";

	it("reads the pair from age-keygen's output", () => {
		const output = [
			"# created: 2026-10-01T02:02:35+10:00",
			`# public key: ${publicKey}`,
			"AGE-SECRET-KEY-1TEST",
			"",
		].join("\n");

		expect(ageKeyPair(output)).toEqual(
			Option.some({ publicKey, secretKey: "AGE-SECRET-KEY-1TEST" }),
		);
	});

	it("rejects output without both keys", () => {
		expect(ageKeyPair(`# public key: ${publicKey}\n`)).toEqual(Option.none());
		expect(ageKeyPair("# public key: age1short\nAGE-SECRET-KEY-1TEST\n")).toEqual(Option.none());
	});
});
