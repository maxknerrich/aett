import {
	Array as Arr,
	Config,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
	type Terminal,
} from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
	aettDependency,
	duplicateName,
	FleetName,
	fleetSource,
	type NewMachine,
	newMachineName,
	type PackageManager,
	packageManager,
	roles,
} from "../domain/scaffold.ts";
import { ageKeyPair, type Operator, SshPublicKey } from "../domain/state.ts";
import { Engine } from "../engine/engine.ts";

export class CreateError extends Schema.TaggedError<CreateError>()("CreateError", {
	message: Schema.String,
}) {}

/** The running aett package, which a new fleet depends on. */
export interface AettPackage {
	readonly directory: string;
	readonly version: string;
}

/** The answers `aett create` takes as flags instead of prompts. */
export interface CreateOptions {
	readonly name: Option.Option<string>;
	readonly sshKey: Option.Option<string>;
	/** Machines from --machine; when there are none, create asks unless `noMachines`. */
	readonly machines: ReadonlyArray<NewMachine>;
	readonly noMachines: boolean;
	/** Installs aett with this instead of the package manager that started aett. */
	readonly packageManager: Option.Option<PackageManager>;
}

const isSshPublicKey = Schema.is(SshPublicKey);

const isFleetName = Schema.is(FleetName);

/**
 * Starts a fleet in a new directory under `cwd`: asks for its name, the
 * operator's SSH key and its first machines, writes fleet.ts, package.json,
 * .gitignore and state/operator.json, makes it a Git repository and installs
 * aett with the package manager that started aett. A new age key encrypts the
 * fleet's secrets; its private half is shown once and never stored.
 */
export const create = Effect.fn("create")(function* (
	cwd: string,
	aett: AettPackage,
	options: CreateOptions,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const name = yield* Option.match(options.name, {
		onSome: (given) =>
			Schema.decodeUnknownEffect(FleetName)(given).pipe(
				Effect.mapError(
					() =>
						new CreateError({
							message: `"${given}" can't name a fleet. Use lowercase letters, digits, dots, dashes and underscores.`,
						}),
				),
			),
		onNone: () =>
			Prompt.String({
				message: "Fleet name (also its directory)",
				validate: (value) =>
					isFleetName(value)
						? Effect.succeed(value)
						: Effect.fail("Use lowercase letters, digits, dots, dashes and underscores"),
			}),
	});

	const root = path.join(cwd, name);

	if ((yield* fs.exists(root)) && (yield* fs.readDirectory(root)).length > 0) {
		return yield* new CreateError({
			message: `${root} already exists and is not empty. aett create starts a new fleet in a new directory.`,
		});
	}

	const key = yield* Option.match(options.sshKey, {
		onNone: () => agentKey,
		onSome: (value) =>
			Effect.gen(function* () {
				const isLine = isSshPublicKey(value.trim());
				const isFile = !isLine && (yield* fs.exists(value));
				const line = isFile ? (yield* fs.readFileString(value)).trim() : value.trim();

				if ((isLine || isFile) && isSshPublicKey(line) && (yield* keygenAccepts(line))) return line;

				return yield* new CreateError({
					message: isFile
						? `${value} does not hold an OpenSSH public key. Pass the .pub file.`
						: "--ssh-key takes an OpenSSH public key line or the path to a .pub file.",
				});
			}),
	});

	if (options.noMachines && options.machines.length > 0) {
		return yield* new CreateError({ message: "Pass either --machine or --no-machines, not both." });
	}

	const machines =
		options.machines.length > 0 || options.noMachines ? options.machines : yield* askMachines([]);

	const duplicate = duplicateName(machines);

	if (Option.isSome(duplicate)) {
		return yield* new CreateError({
			message: `--machine names ${duplicate.value} twice; a fleet's machine names are unique.`,
		});
	}

	const age = yield* ageKey;
	const userAgent = yield* Config.option(Config.String("npm_config_user_agent")).pipe(Effect.orDie);
	const manager = Option.getOrElse(options.packageManager, () => packageManager(userAgent));

	// aett runs from a source checkout unless it was installed into node_modules.
	const checkout = aett.directory.split(path.sep).includes("node_modules")
		? Option.none()
		: Option.some(aett.directory);

	const manifest = {
		name,
		private: true,
		type: "module",
		dependencies: { aett: aettDependency(manager, checkout, aett.version) },
	};

	yield* fs.makeDirectory(path.join(root, "state"), { recursive: true });
	yield* fs.writeFileString(path.join(root, "fleet.ts"), fleetSource(machines));
	yield* fs.writeFileString(
		path.join(root, "package.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	yield* fs.writeFileString(path.join(root, ".gitignore"), "node_modules/\n.aett/build/\n");
	yield* fs.writeFileString(
		path.join(root, "state", "operator.json"),
		`${JSON.stringify({ sshKeys: [key], age: age.publicKey } satisfies Operator, null, "\t")}\n`,
	);
	yield* Console.log(`\nWrote the fleet to ${path.relative(cwd, root)}/.`);

	// Shown as soon as its public half is in state, so no later failure can lose it.
	yield* Console.log(
		[
			"",
			"Your private age key decrypts the fleet's secrets. aett shows it only this once:",
			"",
			`  ${age.secretKey}`,
			"",
			"Store it in your password manager. aett reads it from SOPS_AGE_KEY.",
			"",
		].join("\n"),
	);

	const failures = Arr.getSomes([yield* gitInit(root), yield* installDependencies(root, manager)]);

	yield* Effect.forEach(failures, (failure) => Console.error(failure));

	const next =
		machines.length === 0
			? "  Declare machines in fleet.ts, then boot one from the aett installer and run aett machine install <name>."
			: `  Boot ${machines.length === 1 ? "the machine" : "a machine"} from the aett installer, then: aett machine install ${machines[0]?.name ?? "<name>"}`;

	yield* Console.log(["", "Next:", `  cd ${path.relative(cwd, root)}`, next].join("\n"));

	return yield* failures.length === 0
		? Effect.void
		: new CreateError({
				message: `The fleet is written, but setting it up failed as shown above. Finish those steps in ${path.relative(cwd, root)}/ by hand.`,
			});
});

// Asks for the fleet's first machines one by one until the operator stops, adding them to `machines`.
const askMachines = (
	machines: ReadonlyArray<NewMachine>,
): Effect.Effect<ReadonlyArray<NewMachine>, Terminal.QuitError, Prompt.Environment> =>
	Prompt.Confirm({
		message: machines.length === 0 ? "Add a machine?" : "Add another machine?",
		initial: machines.length === 0,
	}).pipe(
		Effect.flatMap((more) =>
			more
				? askMachine(machines).pipe(
						Effect.flatMap((machine) => askMachines([...machines, machine])),
					)
				: Effect.succeed(machines),
		),
	);

// Asks for one machine's name and role, then whether it's a Mac or whether to encrypt its disk.
const askMachine = Effect.fnUntraced(function* (machines: ReadonlyArray<NewMachine>) {
	const name = yield* Prompt.String({
		message: "Machine name (its hostname)",
		validate: (value) => Effect.fromResult(newMachineName(machines, value)),
	});

	const role = yield* Prompt.Select({
		message: `What is ${name}?`,
		choices: roles.map(({ role: value, description }) => ({ title: value, value, description })),
	});

	const mac = role === "computer" && (yield* Prompt.Confirm({ message: `Is ${name} a Mac?` }));

	const encrypted =
		!mac &&
		(yield* Prompt.Confirm({
			message: "Encrypt its disk? You type a passphrase at its console on every boot.",
		}));

	return { name, role, mac, encrypted } satisfies NewMachine;
});

// Makes the fleet a Git repository with the pinned git. Returns why it failed, if it did.
const gitInit = Effect.fn("gitInit")(function* (root: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const git = path.join(yield* (yield* Engine).tools, "git");

	const exitCode = yield* spawner
		.exitCode(ChildProcess.make(git, ["init", "--quiet", root], { stdin: "ignore" }))
		.pipe(Effect.catchTag("PlatformError", () => Effect.succeed(-1)));

	return exitCode === 0 ? Option.none() : Option.some("git init failed.");
});

// Installs the fleet's dependencies with `manager`. Its output shows only when it fails, as the reason.
const installDependencies = Effect.fn("installDependencies")(
	function* (root: string, manager: PackageManager) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		yield* Console.log(`Installing aett with ${manager}…`);

		const handle = yield* spawner.spawn(
			ChildProcess.make(manager, ["install"], { cwd: root, stdin: "ignore" }),
		);

		const [output, exitCode] = yield* Effect.all(
			[Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
			{ concurrency: "unbounded" },
		);

		return exitCode === 0
			? Option.none()
			: Option.some(
					`${manager} install failed:\n${output.trim().split("\n").slice(-20).join("\n")}`,
				);
	},
	Effect.scoped,
	(effect, _root, manager) =>
		effect.pipe(
			Effect.catchTag("PlatformError", (error) =>
				Effect.succeed(Option.some(`Could not run ${manager}: ${error.message}`)),
			),
		),
);

/** Takes the operator's key from the SSH agent, asking which one when it holds several. */
const agentKey = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const tools = yield* (yield* Engine).tools;
	const lines = yield* spawner.lines(ChildProcess.make(path.join(tools, "ssh-add"), ["-L"]));
	const [first, ...rest] = lines.filter(isSshPublicKey);

	if (first === undefined) {
		return yield* new CreateError({
			message: "The SSH agent holds no keys. Add one with ssh-add, or pass --ssh-key.",
		});
	}

	if (rest.length === 0) {
		return yield* Console.log(`Using the SSH key ${keyLabel(first)} from your agent.`).pipe(
			Effect.as(first),
		);
	}

	return yield* Prompt.Select({
		message: "Which SSH key should aett use?",
		choices: [first, ...rest].map((key) => ({ title: keyLabel(key), value: key })),
	});
});

/** Makes the operator's age key pair with the pinned age-keygen. */
const ageKey = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const tools = yield* (yield* Engine).tools;

	const output = yield* spawner.string(
		ChildProcess.make(path.join(tools, "age-keygen"), [], {
			stdin: "ignore",
			stderr: "ignore",
		}),
	);

	return yield* Effect.fromOption(
		ageKeyPair(output),
		() => new CreateError({ message: "age-keygen printed no key pair." }),
	);
});

/** Asks the pinned ssh-keygen whether OpenSSH can parse the key; the pattern alone lets truncated blobs through. */
const keygenAccepts = Effect.fnUntraced(function* (key: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const tools = yield* (yield* Engine).tools;

	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(path.join(tools, "ssh-keygen"), ["-l", "-f", "/dev/stdin"], {
			stdin: Stream.make(new TextEncoder().encode(`${key}\n`)),
			stdout: "ignore",
			stderr: "ignore",
		}),
	);

	return exitCode === 0;
});

/** Shows a key by its type and comment, or the end of its blob when it has no comment. */
const keyLabel = (key: string) => {
	const [type, blob = "", ...comment] = key.split(" ");

	return comment.length > 0 ? `${comment.join(" ")} (${type})` : `…${blob.slice(-16)} (${type})`;
};
