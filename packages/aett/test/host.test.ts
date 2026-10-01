import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { parseHost, trustHost } from "../src/domain/host.ts";

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

describe("trustHost", () => {
	it("replaces only the lines that name the machine", () => {
		const knownHosts = [
			"# aett's known hosts",
			"box ssh-ed25519 AAAAold",
			"boxer ssh-ed25519 AAAAboxer",
			"web,box ecdsa-sha2-nistp256 AAAAboth",
			"web ssh-ed25519 AAAAweb",
			"",
		].join("\n");

		expect(trustHost(knownHosts, "box", "ssh-ed25519 AAAAnew root@box")).toBe(
			[
				"# aett's known hosts",
				"boxer ssh-ed25519 AAAAboxer",
				"web ssh-ed25519 AAAAweb",
				"box ssh-ed25519 AAAAnew root@box",
				"",
			].join("\n"),
		);
	});

	it("starts a missing file", () => {
		expect(trustHost("", "box", "ssh-ed25519 AAAAnew root@box")).toBe(
			"box ssh-ed25519 AAAAnew root@box\n",
		);
	});
});
