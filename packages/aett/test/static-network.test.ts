import { describe, expect, it } from "vite-plus/test";
import { staticProfiles } from "../src/engine/nix/static-network.ts";

const loopback = { ifname: "lo", link_type: "loopback", address: "00:00:00:00:00:00" };

// A network card: physical links name their bus.
const card = (ifname: string, address: string) => ({
	ifname,
	link_type: "ether",
	address,
	parentbus: "pci",
});

describe("staticProfiles", () => {
	it("carries a rented server's fixed addresses, gateways, routes and name servers, matched by MAC", () => {
		expect(
			staticProfiles({
				links: JSON.stringify([loopback, card("eth0", "96:00:01:02:03:04")]),
				addresses: JSON.stringify([
					{
						ifname: "eth0",
						addr_info: [
							{ family: "inet", local: "203.0.113.7", prefixlen: 32, scope: "global" },
							{ family: "inet6", local: "2001:db8::2", prefixlen: 64, scope: "global" },
							{ family: "inet6", local: "fe80::1:2", prefixlen: 64, scope: "link" },
						],
					},
				]),
				ipv4Routes: JSON.stringify([
					{
						dst: "default",
						gateway: "172.31.1.1",
						dev: "eth0",
						protocol: "static",
						flags: ["onlink"],
					},
					{ dst: "172.31.1.1", dev: "eth0", protocol: "static", scope: "link" },
					{ dst: "10.0.0.0/8", gateway: "172.31.1.1", dev: "eth0", protocol: "static" },
				]),
				ipv6Routes: JSON.stringify([
					{ dst: "2001:db8::/64", dev: "eth0", protocol: "kernel" },
					{ dst: "fe80::/64", dev: "eth0", protocol: "kernel" },
					{ dst: "default", gateway: "fe80::1", dev: "eth0", protocol: "static" },
				]),
				resolvConf:
					"nameserver 127.0.0.53\nnameserver 185.12.64.1\nnameserver 2a01:4ff:ff00::add:1\n",
			}),
		).toEqual([
			{
				name: "eth0",
				keyfile: [
					"[connection]",
					"id=aett-eth0",
					"type=ethernet",
					"autoconnect-priority=100",
					"",
					"[ethernet]",
					"mac-address=96:00:01:02:03:04",
					"",
					"[ipv4]",
					"method=manual",
					"address1=203.0.113.7/32",
					"gateway=172.31.1.1",
					"route1=172.31.1.1/32",
					"route2=10.0.0.0/8,172.31.1.1",
					"dns=185.12.64.1;",
					"",
					"[ipv6]",
					"method=manual",
					"address1=2001:db8::2/64",
					"gateway=fe80::1",
					"dns=2a01:4ff:ff00::add:1;",
					"",
				].join("\n"),
			},
		]);
	});

	it("gives a bridge's fixed address to its network card and leaves virtual links out", () => {
		const profiles = staticProfiles({
			links: JSON.stringify([
				loopback,
				{ ...card("enp1s0", "8c:16:45:00:00:01"), master: "br0" },
				{ ifname: "br0", link_type: "ether", address: "52:54:00:aa:bb:cc" },
				{ ifname: "docker0", link_type: "ether", address: "02:42:00:00:00:01" },
				{ ifname: "tailscale0", link_type: "none" },
			]),
			addresses: JSON.stringify([
				{
					ifname: "br0",
					addr_info: [{ family: "inet", local: "192.168.1.10", prefixlen: 24, scope: "global" }],
				},
				{
					ifname: "docker0",
					addr_info: [{ family: "inet", local: "172.17.0.1", prefixlen: 16, scope: "global" }],
				},
				{
					ifname: "tailscale0",
					addr_info: [{ family: "inet", local: "100.64.0.5", prefixlen: 32, scope: "global" }],
				},
			]),
			ipv4Routes: JSON.stringify([
				{ dst: "default", gateway: "192.168.1.1", dev: "br0", protocol: "static" },
			]),
			ipv6Routes: "[]",
			resolvConf: "nameserver 192.168.1.1\n",
		});

		expect(profiles.map(({ name }) => name)).toEqual(["br0"]);
		expect(profiles[0]?.keyfile).toContain("mac-address=8c:16:45:00:00:01\n");
		expect(profiles[0]?.keyfile).toContain("address1=192.168.1.10/24\ngateway=192.168.1.1\n");
	});

	it("leaves addresses from DHCP and router advertisements to the installer", () => {
		expect(
			staticProfiles({
				links: JSON.stringify([loopback, card("eth0", "96:00:01:02:03:04")]),
				addresses: JSON.stringify([
					{
						ifname: "eth0",
						addr_info: [
							{ family: "inet", local: "10.0.0.5", prefixlen: 24, scope: "global", dynamic: true },
							{
								family: "inet6",
								local: "2001:db8::5",
								prefixlen: 64,
								scope: "global",
								dynamic: true,
							},
						],
					},
				]),
				ipv4Routes: JSON.stringify([
					{ dst: "default", gateway: "10.0.0.1", dev: "eth0", protocol: "dhcp" },
				]),
				ipv6Routes: JSON.stringify([
					{ dst: "default", gateway: "fe80::1", dev: "eth0", protocol: "ra" },
				]),
				resolvConf: "nameserver 10.0.0.1\n",
			}),
		).toEqual([]);
	});
});
