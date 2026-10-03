import { type Cause, Console, Effect, Option, Path, type PlatformError, type Scope } from "effect";
import { type Connection, Ssh, type SshError } from "../adapters/ssh.ts";
import { guestsOf } from "../domain/fleet.ts";
import type { Host } from "../domain/host.ts";
import type { State } from "../domain/state.ts";
import { pinFits } from "../domain/pins.ts";
import { Engine, type EngineError } from "../engine/engine.ts";
import { emitAsIs, notBuilt } from "./compile.ts";
import { pendingSecrets } from "./secrets.ts";

// One way to a machine: how the line names it, and the login it takes.
interface Way {
	readonly label: string;
	readonly connect: Effect.Effect<
		Connection,
		SshError | EngineError | PlatformError.PlatformError | Cause.NoSuchElementError,
		Scope.Scope
	>;
}

// The first way in that answers, with its label; none when none does.
const reach = (ways: ReadonlyArray<Way>) =>
	Effect.firstSuccessOf(
		ways.map(({ label, connect }) => Effect.map(connect, (connection) => ({ label, connection }))),
	).pipe(Effect.option);

// The tailnet address state recorded for a machine, as an SSH endpoint.
const tailnetHost = (state: State, name: string) =>
	Option.map(Option.fromUndefinedOr(state.machines.get(name)?.tailnet), (address): Host => ({
		name: address,
		port: 22,
	}));

/**
 * Prints a line per declared machine, from asking each one: how aett reached
 * it, its tailnet address, whether it runs the system fleet.ts would build,
 * and for a machine that runs VMs, whether each guest runs. A machine the
 * build leaves out says why. It builds from what the fleet records, trusts
 * only the host keys aett recorded, and changes nothing.
 */
export const status = Effect.fn("status")(function* (root: string) {
	const engine = yield* Engine;
	const ssh = yield* Ssh;
	const path = yield* Path.Path;
	const knownHosts = path.join(root, "state", "known_hosts");
	const { build, fleet, state, pins } = yield* emitAsIs(root);
	const unshared = yield* pendingSecrets(root, fleet, state);
	const width = Math.max(...fleet.machines.map(({ name }) => name.length));

	// The system the build makes for each machine it covers, from one evaluation when a line first
	// asks. When the build doesn't evaluate as a whole, each machine is evaluated alone, so one whose
	// declaration fails leaves the others' comparisons.
	const linux = build.machines.filter((name) => !build.macs.includes(name));

	const expected = yield* Effect.cached(
		engine.systemPaths(build, linux).pipe(
			Effect.catchTag("EngineError", () =>
				Effect.forEach(linux, (name) =>
					engine.systemPaths(build, [name]).pipe(
						Effect.map((paths) => [...paths]),
						Effect.orElseSucceed(() => []),
					),
				).pipe(Effect.map((each) => new Map(each.flat()))),
			),
		),
	);

	// A bare-metal machine's way in: the tailnet.
	const metal = (name: string): ReadonlyArray<Way> =>
		Option.toArray(
			Option.map(tailnetHost(state, name), (host) => ({
				label: "the tailnet",
				connect: ssh.machine(name, host, knownHosts, "refuse"),
			})),
		);

	// A guest's ways in: the tailnet first, through its host second.
	const guest = (name: string, host: string): ReadonlyArray<Way> => [
		...Option.toArray(
			Option.map(tailnetHost(state, name), (tailnet) => ({
				label: "the tailnet",
				connect: ssh.machine(name, tailnet, knownHosts, "refuse"),
			})),
		),
		{
			label: `through ${host}`,
			connect: reach(metal(host)).pipe(
				Effect.flatMap(Effect.fromOption),
				Effect.flatMap(({ connection }) =>
					ssh.guest(
						name,
						state.machines.get(name)?.address ?? "",
						knownHosts,
						connection,
						"refuse",
					),
				),
			),
		},
	];

	// The guests that state places on `host` or fleet.ts declares there.
	const guestsOn = (host: string) => [
		...new Set([
			...guestsOf(fleet, host),
			...[...state.machines].flatMap(([name, record]) => (record.host === host ? [name] : [])),
		]),
	];

	const describe = (name: string) =>
		Effect.gen(function* () {
			if (!build.machines.includes(name)) return notBuilt(fleet, state, name);

			// aett doesn't log in to Macs: each applies to itself.
			if (fleet.machines.some((declared) => declared.name === name && declared.kind === "macos")) {
				return "a Mac, which aett apply on it brings up to date";
			}

			const machine = Option.fromUndefinedOr(
				fleet.machines.find((declared) => declared.name === name),
			);

			const host = Option.flatMap(machine, ({ vm }) => vm);

			const reached = yield* reach(
				Option.match(host, { onNone: () => metal(name), onSome: (vm) => guest(name, vm.host) }),
			);

			if (Option.isNone(reached)) {
				return Option.isNone(tailnetHost(state, name)) && Option.isNone(host)
					? "not on the tailnet yet"
					: "unreachable";
			}

			const { label, connection } = reached.value;
			const running = yield* engine.currentSystem(connection);
			const tailnet = (yield* connection.run("tailscale ip -4 2>/dev/null || true")).trim();

			// What apply would change in this machine's system before building it: a release without a
			// fitting pin, its own or a guest's, since a host's system holds its guests', and a secret
			// they read that apply asks for or re-encrypts, or that aett can't check. Comparing would
			// then say nothing.
			const included = fleet.machines.filter(
				({ name: other, vm }) => other === name || Option.exists(vm, ({ host: on }) => on === name),
			);

			const unpinned = included
				.flatMap(({ releases }) => releases)
				.filter((release) =>
					Option.match(Option.fromUndefinedOr(pins.releases[release.github]), {
						onNone: () => true,
						onSome: (pin) => !pinFits(pin, release),
					}),
				);

			const secrets = unshared.filter(({ secret }) =>
				included.some(({ name: reader }) => secret.readers.includes(reader)),
			);

			// A package without a source yet is left out of the build until apply picks one.
			const unsourced = [
				...new Set(
					included.flatMap(({ packages }) =>
						packages.filter((pkg) => pins.packages[pkg] === undefined),
					),
				),
			];

			const pending = [
				...unpinned.map(({ bin }) => `${bin} isn't pinned yet`),
				...unsourced.map((pkg) => `${pkg} isn't pinned yet`),
				...secrets.map(({ secret, reason }) => `${secret.name} ${reason}`),
			];

			// A declaration that doesn't evaluate still leaves what the machine said.
			const comparison =
				pending.length > 0
					? `not compared: ${pending.join("; ")}`
					: Option.match(Option.fromUndefinedOr((yield* expected).get(name)), {
							onNone: () => "fleet.ts doesn't evaluate for it",
							onSome: (system) => (running === system ? "runs fleet.ts" : "differs from fleet.ts"),
						});

			const guests = yield* Effect.forEach(guestsOn(name), (on) =>
				Effect.map(engine.guestState(connection, on), (unit) => `${on} ${unit}`),
			);

			// Each plugin's own health check, run where it is; tailscale's is the tailnet line above.
			const health = yield* Effect.forEach(
				Option.match(machine, { onNone: () => [], onSome: ({ services }) => services }).filter(
					({ name: service }) => service !== "tailscale",
				),
				({ name: service }) =>
					Option.match(Option.fromUndefinedOr(fleet.services.get(service)?.plugin.health), {
						onNone: () => Effect.succeed([]),
						// Its exit status and the first line it printed, which says how it is either way.
						onSome: (check) =>
							connection
								.run(
									`said=$( (${check}) 2>&1 ); code=$?; printf '%s %s\\n' "$code" "$(printf '%s' "$said" | head -n 1)"`,
								)
								.pipe(
									Effect.map((printed) => {
										const [code = "", ...words] = printed.trim().split(" ");
										const said = words.join(" ");

										return [
											code === "0"
												? `${service} ${said || "healthy"}`
												: `${service} unhealthy${said === "" ? "" : `: ${said}`}`,
										];
									}),
									Effect.catchTag("SshError", () => Effect.succeed([`${service} unhealthy`])),
								),
					}),
			);

			return [
				`reached at ${label}`,
				tailnet === "" ? "not on the tailnet" : `tailnet ${tailnet.split("\n")[0]}`,
				comparison,
				...health.flat(),
				...(guests.length > 0 ? [`guests: ${guests.join(", ")}`] : []),
			].join(" · ");
		}).pipe(
			Effect.scoped,
			// One machine that fails halfway leaves its line and the others.
			Effect.catch((error) => Effect.succeed(`failed: ${error.message}`)),
		);

	// Every machine is asked at once; the lines keep fleet.ts's order.
	const lines = yield* Effect.forEach(
		fleet.machines,
		({ name }) => Effect.map(describe(name), (text) => `${name.padEnd(width)}  ${text}`),
		{ concurrency: "unbounded" },
	);

	yield* Console.log(lines.join("\n"));
});
