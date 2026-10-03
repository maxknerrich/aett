import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { isPassphrase, poolProblem } from "../src/domain/disk.ts";

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

describe("poolProblem", () => {
	const disk = (id: string) => ({
		model: "QEMU",
		byId: `/dev/disk/by-id/${id}`,
		bytes: 1e10,
		names: [`/dev/disk/by-id/${id}`, `/dev/${id}`],
	});

	it("wants two disks per pool and no disk twice, under any of its names", () => {
		const [a, b, c, d] = [disk("a"), disk("b"), disk("c"), disk("d")];

		expect(poolProblem({ root: [a, b], tank: [c, d] })).toEqual(Option.none());
		expect(poolProblem({ root: [a], tank: [c, d] })).toEqual(
			Option.some("The root pool mirrors at least two disks."),
		);
		expect(poolProblem({ root: [a, b], tank: [c, { ...disk("x"), names: ["/dev/a"] }] })).toEqual(
			Option.some("/dev/disk/by-id/x is chosen twice."),
		);
	});
});
