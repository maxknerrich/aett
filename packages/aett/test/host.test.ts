import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { parseHost } from "../src/domain/host.ts";

describe("parseHost", () => {
	it("defaults the port to 22", () => {
		expect(parseHost("aett-installer.local")).toEqual(
			Option.some({ name: "aett-installer.local", port: 22 }),
		);
	});

	it("reads a port after the host", () => {
		expect(parseHost("127.0.0.1:2222")).toEqual(Option.some({ name: "127.0.0.1", port: 2222 }));
	});

	it.each(["", "box:", "box:0", "box:65536", "root@box", "box:22:22", "fe80::1", "a b"])(
		"rejects %j",
		(input) => {
			expect(parseHost(input)).toEqual(Option.none());
		},
	);
});
