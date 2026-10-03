import { arch, platform } from "node:os";
import { Console, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { localConnection } from "../adapters/local.ts";
import { Secrets } from "../adapters/secrets.ts";
import type { Fleet, Machine } from "../domain/fleet.ts";
import type { Entry } from "../domain/home.ts";
import { ageKeyPair } from "../domain/state.ts";
import type { State } from "../domain/state.ts";
import { type Build, Engine } from "../engine/engine.ts";
import { applyHome, planHome } from "./home.ts";
import { updateRecord } from "./load.ts";

export class MacError extends Schema.TaggedError<MacError>()("MacError", {
	message: Schema.String,
}) {}

// Where a Mac's own age key lives in the fleet, encrypted to the operators.
const ageKeyFile = (name: string) => `secrets/${name}/age-key.json`;

/** Homebrew's binary on this Mac, wherever it was installed. */
const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

/**
 * The Mac in `fleet` that aett runs on: the one named, or else the one whose
 * local host name it has. None off macOS.
 */
export const thisMac = Effect.fn("thisMac")(function* (fleet: Fleet, named: Option.Option<string>) {
	if (platform() !== "darwin") return Option.none<Machine>();

	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	const local = (yield* spawner
		.string(ChildProcess.make("/usr/sbin/scutil", ["--get", "LocalHostName"], { stdin: "ignore" }))
		.pipe(Effect.orElseSucceed(() => "")))
		.trim()
		.toLowerCase();

	return Option.fromUndefinedOr(
		fleet.machines.find(
			(machine) =>
				machine.kind === "macos" && Option.getOrElse(named, () => local) === machine.name,
		),
	);
});

/**
 * Records what aett needs to build the Mac it runs on before its first apply:
 * its platform, whether it runs the Tailscale app, and an age key of its own
 * for its secrets, kept encrypted to the operators.
 */
export const prepareMac = Effect.fn("prepareMac")(function* (
	root: string,
	state: State,
	name: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const secrets = yield* Secrets;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const recorded = state.machines.get(name);

	const system = arch() === "arm64" ? "aarch64-darwin" : "x86_64-darwin";
	const app = yield* fs.exists("/Applications/Tailscale.app");

	if (recorded?.system !== system || recorded.tailscaleApp !== app) {
		yield* updateRecord(root, name, { system, tailscaleApp: app });
	}

	if (recorded?.age !== undefined && (yield* fs.exists(path.join(root, ageKeyFile(name))))) {
		return;
	}

	const keygen = path.join(yield* (yield* Engine).tools, "age-keygen");
	const generated = yield* spawner.string(ChildProcess.make(keygen, [], { stdin: "ignore" }));

	const pair = yield* Effect.fromOption(
		ageKeyPair(generated),
		() => new MacError({ message: "age-keygen printed no key pair." }),
	);

	yield* secrets.write(root, ageKeyFile(name), state.operator.ageKeys, pair.secretKey);
	yield* updateRecord(root, name, { age: pair.publicKey });
	yield* Console.log(`Made ${name}'s age key, which its secrets are encrypted to.`);
});

// Runs Homebrew as the operator without asking anything; returns what it printed and its exit code.
const runBrew = Effect.fn("runBrew")(function* (args: ReadonlyArray<string>) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [binary] = yield* Effect.filter(brew, (candidate) => fs.exists(candidate));

	if (binary === undefined) {
		return yield* new MacError({
			message:
				"Homebrew isn't installed, and a Mac's apps come through it. Install it first: /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
		});
	}

	return yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(
				ChildProcess.make(binary, [...args], {
					env: { HOMEBREW_NO_AUTO_UPDATE: "1" },
					extendEnv: true,
					stdin: "ignore",
				}),
			);

			const [stdout, exitCode] = yield* Effect.all(
				[Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
				{ concurrency: "unbounded" },
			);

			return { stdout, exitCode };
		}),
	).pipe(
		Effect.mapError((error) => new MacError({ message: `Could not run brew: ${error.message}` })),
	);
});

/**
 * The apps and formulae Homebrew has on this Mac that `brewfile` doesn't
 * list: what applying with zap removes. brew bundle cleanup lists them
 * without --force and fails when it finds any.
 */
const undeclared = Effect.fn("undeclared")(function* (brewfile: string) {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* fs.makeTempDirectoryScoped({ prefix: "aett-" });
	const file = `${directory}/Brewfile`;

	yield* fs.writeFileString(file, brewfile);

	const { stdout } = yield* runBrew(["bundle", "cleanup", `--file=${file}`]);

	// It prints a heading per kind, such as "Would uninstall casks:", then a name per line.
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !/^(Would|Run) /.test(line));
}, Effect.scoped);

/** Whether this run should go on: the operator agreed, or `yes` answers for them. */
const agree = (yes: boolean, message: string) =>
	yes ? Effect.succeed(true) : Prompt.Confirm({ message });

/**
 * Applies the Mac aett runs on: builds its nix-darwin system here, shows what
 * changes, and once the operator agrees, switches to it through sudo and
 * syncs the home. The first time, it lists the Homebrew apps fleet.ts doesn't
 * name and asks once whether apply may remove them, now and from then on.
 * Returns whether the build has to be made again because that answer changed
 * it.
 */
export const applyMac = Effect.fn("applyMac")(function* (
	root: string,
	build: Build,
	state: State,
	machine: Machine,
	user: string,
	home: Option.Option<ReadonlyArray<Entry>>,
	yes: boolean,
) {
	const engine = yield* Engine;
	const secrets = yield* Secrets;
	const connection = yield* localConnection;
	const recorded = state.machines.get(machine.name);

	if (recorded?.zap === undefined) {
		const extra = yield* undeclared(yield* engine.brewfile(build, machine.name));

		const zap =
			extra.length === 0 ||
			(yield* Prompt.Confirm({
				message: [
					`Homebrew has these on ${machine.name}, and fleet.ts doesn't list them:`,
					...extra.map((line) => `  ${line}`),
					"Remove them now, and from now on whatever fleet.ts drops? (aett asks only this once)",
				].join("\n"),
				initial: false,
			}));

		yield* updateRecord(root, machine.name, { zap });

		if (zap && extra.length > 0) return true;
	}

	const system = yield* engine.buildDarwin(build, machine.name);

	const current = (yield* connection
		.run("readlink /run/current-system || true")
		.pipe(Effect.orElseSucceed(() => ""))).trim();

	if (current === system) {
		yield* Console.log(`${machine.name} is up to date.`);
	} else {
		const changes =
			current === ""
				? "nix-darwin takes over this Mac."
				: (yield* connection.run(`nix store diff-closures ${current} ${system}`)).trim();

		yield* Console.log(
			changes === ""
				? `${machine.name}'s new system changes no package versions.`
				: `Changes on ${machine.name}:\n${changes}`,
		);

		if (!(yield* agree(yes, `Switch ${machine.name} to the new system?`))) {
			yield* Console.log(`Left ${machine.name} as it is.`);

			return false;
		}

		yield* Console.log(`Switching ${machine.name}; sudo asks for your password or Touch ID…`);
		yield* engine.activateDarwin(
			system,
			Redacted.make(yield* secrets.read(root, ageKeyFile(machine.name))),
		);
		yield* Console.log(`Switched ${machine.name} to ${system}.`);
	}

	yield* Effect.forEach(Option.toArray(home), (entries) =>
		planHome(connection, machine.name, user, entries).pipe(
			Effect.flatMap((sync) =>
				sync.plan.changes
					? agree(yes, `Sync ${user}'s home on ${machine.name}?`).pipe(
							Effect.flatMap((sure) => (sure ? applyHome(connection, sync) : Effect.void)),
						)
					: applyHome(connection, sync),
			),
		),
	);

	return false;
});

/** Upgrades the Mac's Homebrew apps, which aett leaves unpinned. */
export const upgradeApps = Effect.fn("upgradeApps")(function* (machine: Machine) {
	if (machine.apps.length === 0) return yield* Effect.void;

	yield* Console.log(`Upgrading ${machine.name}'s apps…`);

	const { stdout, exitCode } = yield* runBrew(["upgrade", "--cask", ...machine.apps]);

	yield* Console.log(stdout.trim() === "" ? "Its apps are up to date." : stdout.trim());

	return yield* exitCode === 0
		? Effect.void
		: new MacError({ message: `brew upgrade failed with exit code ${exitCode}.` });
});

/** The casks Homebrew has on this Mac, which aett create adopts as its apps. */
export const installedApps = runBrew(["list", "--cask", "-1"]).pipe(
	Effect.map(({ stdout }) =>
		stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== ""),
	),
	Effect.orElseSucceed((): ReadonlyArray<string> => []),
);
