import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { machineSecrets } from "../src/domain/secrets.ts";
import { fleet, hypervisor, mac, vm } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

describe("machineSecrets", () => {
	it("gives the user's password to NixOS machines with a home and each plugin secret its readers, as its per says", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor(),
					hades: vm({ host: "kronos" }),
					zeus: vm({ host: "kronos" }),
					fawkes: mac(),
				},
				services: { backup: { server: "hades" } },
			}),
		);

		expect(
			machineSecrets(declared).map(({ name, readers, kind, certificate }) => ({
				name,
				readers,
				kind,
				certificate: Option.getOrNull(certificate),
			})),
		).toEqual([
			{ name: "users/mkn", readers: ["hades", "zeus"], kind: "password", certificate: null },
			{ name: "backup/repository/hades", readers: ["hades"], kind: "random", certificate: null },
			{
				name: "backup/tls/hades",
				readers: ["hades"],
				kind: "certificate",
				certificate: "state/hades/backup.tls.pem",
			},
			{ name: "backup/client/zeus", readers: ["zeus", "hades"], kind: "random", certificate: null },
			{
				name: "backup/client/fawkes",
				readers: ["fawkes", "hades"],
				kind: "random",
				certificate: null,
			},
		]);
	});
});
