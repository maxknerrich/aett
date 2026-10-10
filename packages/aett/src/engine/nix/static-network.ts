import { Option, Schema } from "effect";

// What `ip -json -details link show` says about a link: a network card names its bus, a bridge's or
// bond's port its master.
const Links = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			ifname: Schema.String,
			link_type: Schema.String,
			address: Schema.optionalKey(Schema.String),
			master: Schema.optionalKey(Schema.String),
			parentbus: Schema.optionalKey(Schema.String),
		}),
	),
);

// What `ip -json address show` says about each link's addresses. One from DHCP or router
// advertisements is dynamic.
const Addresses = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			ifname: Schema.String,
			addr_info: Schema.Array(
				Schema.Struct({
					family: Schema.String,
					local: Schema.optionalKey(Schema.String),
					prefixlen: Schema.optionalKey(Schema.Number),
					scope: Schema.optionalKey(Schema.String),
					dynamic: Schema.optionalKey(Schema.Boolean),
				}),
			),
		}),
	),
);

// What `ip -json route show` says about each route.
const Routes = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			dst: Schema.String,
			gateway: Schema.optionalKey(Schema.String),
			dev: Schema.optionalKey(Schema.String),
			protocol: Schema.optionalKey(Schema.String),
			type: Schema.optionalKey(Schema.String),
		}),
	),
);

type Route = (typeof Routes.Type)[number];

const decode = <S extends Schema.Decoder<ReadonlyArray<unknown>>>(schema: S, printed: string) =>
	Option.getOrElse(Schema.decodeUnknownOption(schema)(printed.trim()), (): S["Type"] => []);

// Routes the kernel, DHCP or router advertisements add, which the installer gets by itself.
const automatic = new Set(["kernel", "dhcp", "ra", "redirect"]);

// One address family's section of a profile: the card's own addresses, its gateway and other routes,
// and the name servers. A family without an address of its own asks DHCP or router advertisements.
const section = (
	name: "ipv4" | "ipv6",
	host: number,
	addresses: ReadonlyArray<string>,
	routes: ReadonlyArray<Route>,
	servers: ReadonlyArray<string>,
) => {
	const manual = addresses.length > 0;
	// A gateway needs an address of the card's own.
	const gateway = manual ? routes.find(({ dst }) => dst === "default")?.gateway : undefined;
	const others = routes.filter(({ dst }) => dst !== "default");

	return [
		`[${name}]`,
		`method=${manual ? "manual" : "auto"}`,
		...addresses.map((address, index) => `address${index + 1}=${address}`),
		...(gateway === undefined ? [] : [`gateway=${gateway}`]),
		...others.map(
			({ dst, gateway: via }, index) =>
				`route${index + 1}=${dst.includes("/") ? dst : `${dst}/${host}`}${via === undefined ? "" : `,${via}`}`,
		),
		...(servers.length === 0 ? [] : [`dns=${servers.join(";")};`]),
	].join("\n");
};

/** What a running machine prints about its network: `ip -json` and its resolv.conf. */
export interface PrintedNetwork {
	readonly links: string;
	readonly addresses: string;
	readonly ipv4Routes: string;
	readonly ipv6Routes: string;
	readonly resolvConf: string;
}

/** A NetworkManager keyfile for the network card a running machine calls `name`. */
export interface Profile {
	readonly name: string;
	readonly keyfile: string;
}

/**
 * NetworkManager profiles that give the installer the fixed addresses,
 * routes and name servers a running machine has, so a server without DHCP
 * stays reachable once it switches into the installer. Each matches its
 * network card by MAC address, since the installer names cards its own way; a
 * bridge's or bond's addresses go to its first network card. Addresses from
 * DHCP or router advertisements are left out: the installer asks for them
 * itself.
 */
export const staticProfiles = (printed: PrintedNetwork): ReadonlyArray<Profile> => {
	const cards = decode(Links, printed.links).filter(
		({ link_type, address, parentbus }) =>
			link_type === "ether" && address !== undefined && parentbus !== undefined,
	);

	const nameservers = [...printed.resolvConf.matchAll(/^\s*nameserver\s+(\S+)/gm)].flatMap(
		([, server = ""]) =>
			server.startsWith("127.") || server === "::1" || server.includes("%") ? [] : [server],
	);

	const families = [
		{ name: "ipv4", family: "inet", host: 32, routes: decode(Routes, printed.ipv4Routes) },
		{ name: "ipv6", family: "inet6", host: 128, routes: decode(Routes, printed.ipv6Routes) },
	] as const;

	return decode(Addresses, printed.addresses).flatMap(({ ifname, addr_info }) => {
		const fixed = addr_info.filter(({ scope, dynamic }) => scope === "global" && dynamic !== true);

		const card =
			cards.find((link) => link.ifname === ifname) ?? cards.find((link) => link.master === ifname);

		if (fixed.length === 0 || card?.address === undefined) return [];

		const sections = families.map(({ name, family, host, routes }) =>
			section(
				name,
				host,
				fixed.flatMap(({ family: own, local, prefixlen }) =>
					own === family && local !== undefined && prefixlen !== undefined
						? [`${local}/${prefixlen}`]
						: [],
				),
				routes.filter(
					(route) =>
						route.dev === ifname &&
						!automatic.has(route.protocol ?? "") &&
						(route.type ?? "unicast") === "unicast",
				),
				nameservers.filter((server) => server.includes(":") === (family === "inet6")),
			),
		);

		const head = [
			"[connection]",
			`id=aett-${ifname}`,
			"type=ethernet",
			// Ahead of the profile NetworkManager makes for any wired card.
			"autoconnect-priority=100",
			"",
			"[ethernet]",
			`mac-address=${card.address}`,
		].join("\n");

		return [{ name: ifname, keyfile: `${[head, ...sections].join("\n\n")}\n` }];
	});
};
