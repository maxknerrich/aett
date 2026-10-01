import { describe, expect, it } from "vite-plus/test";
import { sshConfigPath } from "../src/domain/host.ts";

describe("sshConfigPath", () => {
	it("keeps spaces, quotes, backslashes and percent signs literal for ssh", () => {
		expect(sshConfigPath(String.raw`/fleets/my "home" 100%\a/state/known_hosts`)).toBe(
			String.raw`"/fleets/my \"home\" 100%%\\a/state/known_hosts"`,
		);
	});
});
