import { Option } from "effect";
import type { Fleet } from "./fleet.ts";

/**
 * A secret machines read at runtime. It lives in `file`, encrypted to the
 * operators and to every machine in `readers`, and sops-nix puts it at
 * /run/secrets/<name> on them. Plugins' secrets live apart, under
 * secrets/services/, so no plugin's can take a path aett's own use.
 */
export interface MachineSecret {
	/** What sops-nix calls it on the machines: /run/secrets/<name>. */
	readonly name: string;
	/** Where it lives in the fleet. */
	readonly file: string;
	/** The machines that read it. */
	readonly readers: ReadonlyArray<string>;
	/**
	 * How it comes about: asked for as a password, stored as its hash; asked
	 * for as a token; or made by aett as a random password or a self-signed TLS
	 * certificate with its key.
	 */
	readonly kind: "password" | "token" | "random" | "certificate";
	/** What aett asks for a password or token. */
	readonly prompt: string;
	/** Whether aett makes or asks for it the first time a build needs it; the others wait for aett secret set. */
	readonly required: boolean;
	/** Why a value can't be this secret, if it can't. */
	readonly invalid: (value: string) => Option.Option<string>;
	/** Where the public half of a certificate lives in the fleet, once it exists. */
	readonly certificate: Option.Option<string>;
}

/** Where a machine secret lives in the fleet. */
export const secretFile = (name: string) => `secrets/${name}.json`;

const anything = () => Option.none<string>();

// A secret a plugin's entry declares, once or once per machine as its `per` says.
const pluginSecrets = (fleet: Fleet): ReadonlyArray<MachineSecret> =>
	[...fleet.services].flatMap(([service, { plugin, instances, clients }]) =>
		Object.entries(plugin.secrets ?? {}).flatMap(([secret, spec]) => {
			const base = `${service}/${secret}`;
			const configured = [...instances, ...clients];

			const kind =
				"generate" in spec ? (spec.generate === "password" ? "random" : "certificate") : "token";

			const prompt = "prompt" in spec ? spec.prompt : "";

			// `owner` is the machine whose state keeps a certificate's public half; a fleet's is the plugin's.
			const make = (
				name: string,
				readers: ReadonlyArray<string>,
				owner: string | undefined,
			): MachineSecret => ({
				name,
				file: `secrets/services/${name}.json`,
				readers,
				kind,
				prompt,
				required: true,
				invalid: anything,
				certificate:
					kind === "certificate"
						? Option.some(
								owner === undefined
									? `state/services/${service}/${secret}.pem`
									: `state/${owner}/${service}.${secret}.pem`,
							)
						: Option.none(),
			});

			switch (spec.per ?? "fleet") {
				case "instance":
					return instances.map((instance) => make(`${base}/${instance}`, [instance], instance));
				case "client":
					return clients.map((client) => make(`${base}/${client}`, [client, ...instances], client));
				default:
					return [make(base, configured, undefined)];
			}
		}),
	);

/** The secrets the fleet's machines read: the user's password and each plugin's. */
export const machineSecrets = (fleet: Fleet): ReadonlyArray<MachineSecret> => [
	// A Mac's account keeps its own password, so a fleet of Macs has none.
	...Option.toArray(
		Option.map(fleet.user, (user): MachineSecret => ({
			name: `users/${user}`,
			file: secretFile(`users/${user}`),
			readers: fleet.machines
				.filter((machine) => machine.user && machine.kind !== "macos")
				.map(({ name }) => name),
			kind: "password",
			prompt: `Password for ${user}, which sudo asks for on every NixOS machine with a home`,
			required: true,
			invalid: (value) =>
				/^\P{Cc}+$/u.test(value) ? Option.none() : Option.some("Expected a password"),
			certificate: Option.none(),
		})).pipe(Option.filter(({ readers }) => readers.length > 0)),
	),
	...pluginSecrets(fleet),
];
