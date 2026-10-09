import { Option } from "effect";
import type { Fleet, Machine } from "./fleet.ts";
import type { Pins } from "./pins.ts";
import type { State } from "./state.ts";

// A size in MiB as the declaration writes it.
const size = (mebibytes: number) =>
	mebibytes % 1024 === 0 ? `${mebibytes / 1024} GiB` : `${mebibytes} MiB`;

// What a machine is and where it runs, on its first line.
const headline = (machine: Machine, state: State) => {
	const recorded = state.machines.get(machine.name);

	const what = Option.match(machine.vm, {
		onNone: () =>
			machine.kind === "macos"
				? `${machine.role}, a Mac`
				: `${machine.role}${machine.encrypted ? ", encrypted" : ""}`,
		onSome: ({ host, cpu, memory, disk }) =>
			`${machine.role} on ${host}, ${cpu} CPUs, ${size(memory)} memory, ${size(disk)} disk`,
	});

	const tailnet = Option.match(Option.fromUndefinedOr(recorded?.tailnetName ?? recorded?.tailnet), {
		onNone: () => "not on the tailnet yet",
		onSome: (name) => name,
	});

	return `${what} · ${tailnet}`;
};

// The packages by where the pins take them from, a release with its version.
const packagesOf = (machine: Machine, pins: Pins) => {
	const bySource = Map.groupBy(machine.packages, (name) => pins.packages[name] ?? "not pinned yet");

	return [
		...[...bySource].map(([source, names]) => `${names.join(", ")} (${source})`),
		...machine.releases.map(
			({ github, bin }) =>
				`${bin} ${pins.releases[github]?.version ?? "not pinned yet"} (${github})`,
		),
	].join(" · ");
};

/**
 * The fleet by machine, for aett show: what each machine is, its services
 * with their endpoints, the entries it is on, its packages, apps and home
 * trees. It reads only fleet.ts, state and the pins.
 */
export const describeFleet = (fleet: Fleet, state: State, pins: Pins) => {
	const width = Math.max(0, ...fleet.machines.map(({ name }) => name.length));
	const indent = " ".repeat(width + 2);

	const services = (machine: Machine) =>
		machine.services
			.map(({ name, instance }) => {
				const service = fleet.services.get(name);

				if (instance || service === undefined) return name;

				return `${name} client of ${service.instances.join(", ")}`;
			})
			.join(", ");

	const endpoints = (machine: Machine) => {
		const at = state.machines.get(machine.name)?.tailnetName ?? machine.name;

		return machine.services
			.filter(({ instance }) => instance)
			.flatMap(({ name }) =>
				Object.entries(fleet.services.get(name)?.plugin.endpoints ?? {}).map(
					([endpoint, { port, web }]) =>
						`${name} ${endpoint} ${web === true ? `https://${at}:${port}` : `${at}:${port}`}`,
				),
			)
			.join(", ");
	};

	const lines = fleet.machines.flatMap((machine) => {
		const entries = machine.home.filter((name) => name !== "default" && !fleet.services.has(name));

		const details = [
			["services", services(machine)],
			["endpoints", endpoints(machine)],
			["packs", entries.join(", ")],
			["packages", packagesOf(machine, pins)],
			["apps", machine.apps.join(", ")],
			["brews", machine.brews.join(", ")],
			["home", machine.home.map((name) => `home/${name}/`).join(", ")],
			["blocked", machine.unsupported.map((what) => `${what} aren't supported yet`).join(", ")],
		].filter(([, value]) => value !== "");

		return [
			`${machine.name.padEnd(width)}  ${headline(machine, state)}`,
			...details.map(([label = "", value]) => `${indent}${label.padEnd(10)}${value}`),
		];
	});

	return lines.join("\n");
};
