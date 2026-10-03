import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type Declaration, decodeFleet } from "../src/domain/fleet.ts";
import { machineSecrets } from "../src/domain/secrets.ts";
import { fleet, hypervisor, server } from "../src/index.ts";

// The fleet aett works with for a declaration.
const loaded = (declaration: Declaration) => Result.getOrThrow(decodeFleet(declaration));

describe("machineSecrets", () => {
	it("gives each machine its Tailscale key and each plugin secret its readers, as its per says", () => {
		const declared = loaded(
			fleet({
				user: "mkn",
				machines: {
					kronos: hypervisor(),
					hades: server({ host: "kronos" }),
					zeus: server({ host: "kronos" }),
				},
				services: { backup: "hades" },
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
			{ name: "kronos/tailscale-key", readers: ["kronos"], kind: "tailscale", certificate: null },
			{ name: "hades/tailscale-key", readers: ["hades"], kind: "tailscale", certificate: null },
			{ name: "zeus/tailscale-key", readers: ["zeus"], kind: "tailscale", certificate: null },
			{ name: "users/mkn", readers: ["hades", "zeus"], kind: "password", certificate: null },
			{ name: "backup/repository/hades", readers: ["hades"], kind: "random", certificate: null },
			{
				name: "backup/tls/hades",
				readers: ["hades"],
				kind: "certificate",
				certificate: "state/hades/backup.tls.pem",
			},
			{ name: "backup/client/zeus", readers: ["zeus", "hades"], kind: "random", certificate: null },
		]);
	});
});
