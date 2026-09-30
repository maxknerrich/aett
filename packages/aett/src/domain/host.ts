import { Option } from "effect";

/** An SSH endpoint: a host name or IPv4 address and a port. */
export interface Host {
	readonly name: string;
	readonly port: number;
}

/** Where `aett machine install` finds the installer when `--host` is not given. */
export const installerHost: Host = { name: "aett-installer.local", port: 22 };

/** Parses `host[:port]`; the port defaults to 22. */
export const parseHost = (input: string): Option.Option<Host> => {
	const match = /^(?<name>[^\s:@/]+)(?::(?<port>\d{1,5}))?$/.exec(input);
	const port = Number(match?.groups?.port ?? 22);

	return match?.groups?.name === undefined || port < 1 || port > 65_535
		? Option.none()
		: Option.some({ name: match.groups.name, port });
};

/** Shows a host as the operator would type it, leaving out the default port. */
export const formatHost = ({ name, port }: Host) => (port === 22 ? name : `${name}:${port}`);

/**
 * Removes a host's entries from a known_hosts file's content. aett records
 * machine keys under the machine's name (HostKeyAlias), so `name` is that name.
 */
export const forgetHost = (knownHosts: string, name: string) =>
	knownHosts
		.split("\n")
		.filter((line) => !(line.split(/\s/, 1)[0] ?? "").split(",").includes(name))
		.join("\n");
