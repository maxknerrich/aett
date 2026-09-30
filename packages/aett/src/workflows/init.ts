import { Console, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Nix } from "../adapters/nix.ts";
import { SshPublicKey } from "../domain/state.ts";

export class InitError extends Schema.TaggedError<InitError>()("InitError", {
	message: Schema.String,
}) {}

/** The running aett package, which a new fleet depends on. */
export interface AettPackage {
	readonly directory: string;
	readonly version: string;
}

const isSshPublicKey = Schema.is(SshPublicKey);

/**
 * Starts a fleet in `root`: fleet.ts, package.json, .gitignore and
 * state/operator.json. The operator's key comes from `--ssh-key` (a key line
 * or a .pub file) or else from the SSH agent.
 */
export const init = Effect.fn("init")(function* (
	root: string,
	aett: AettPackage,
	sshKey: Option.Option<string>,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files = ["fleet.ts", "package.json", ".gitignore", path.join("state", "operator.json")];

	yield* Effect.filter(files, (file) => fs.exists(path.join(root, file))).pipe(
		Effect.filterOrFail(
			(existing) => existing.length === 0,
			(existing) =>
				new InitError({
					message: `${root} already has ${existing.join(", ")}. aett init only starts a new fleet.`,
				}),
		),
	);

	const key = yield* Option.match(sshKey, {
		onNone: () => agentKey,
		onSome: (value) =>
			Effect.gen(function* () {
				const isLine = isSshPublicKey(value.trim());
				const isFile = !isLine && (yield* fs.exists(value));
				const line = isFile ? (yield* fs.readFileString(value)).trim() : value.trim();

				if ((isLine || isFile) && isSshPublicKey(line) && (yield* keygenAccepts(line))) return line;

				return yield* new InitError({
					message: isFile
						? `${value} does not hold an OpenSSH public key. Pass the .pub file.`
						: "--ssh-key takes an OpenSSH public key line or the path to a .pub file.",
				});
			}),
	});

	// A source checkout is linked; an installed package is depended on by version.
	const dependency = aett.directory.split(path.sep).includes("node_modules")
		? `^${aett.version}`
		: `link:${aett.directory}`;

	const manifest = {
		name: path
			.basename(root)
			.toLowerCase()
			.replaceAll(/[^a-z0-9._~-]+/g, "-"),
		private: true,
		type: "module",
		dependencies: { aett: dependency },
	};

	yield* fs.makeDirectory(path.join(root, "state"), { recursive: true });
	yield* fs.writeFileString(
		path.join(root, "fleet.ts"),
		'import { fleet } from "aett"\n\nexport default fleet({\n\tmachines: [],\n})\n',
	);
	yield* fs.writeFileString(
		path.join(root, "package.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	yield* fs.writeFileString(path.join(root, ".gitignore"), "node_modules/\n.aett/build/\n");
	yield* fs.writeFileString(
		path.join(root, "state", "operator.json"),
		`${JSON.stringify({ sshKeys: [key] }, null, "\t")}\n`,
	);

	yield* Console.log(`Started a fleet in ${root}.`);
	yield* Console.log(
		"Next: install its dependencies (pnpm install) and declare machines in fleet.ts.",
	);
});

/** Takes the operator's key from the SSH agent, asking which one when it holds several. */
const agentKey = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const tools = yield* (yield* Nix).tools;
	const lines = yield* spawner.lines(ChildProcess.make(path.join(tools, "bin", "ssh-add"), ["-L"]));
	const [first, ...rest] = lines.filter(isSshPublicKey);

	if (first === undefined) {
		return yield* new InitError({
			message: "The SSH agent holds no keys. Add one with ssh-add, or pass --ssh-key.",
		});
	}

	if (rest.length === 0) return first;

	return yield* Prompt.Select({
		message: "Which SSH key should aett use?",
		choices: [first, ...rest].map((key) => ({ title: keyLabel(key), value: key })),
	});
});

/** Asks the pinned ssh-keygen whether OpenSSH can parse the key; the pattern alone lets truncated blobs through. */
const keygenAccepts = Effect.fnUntraced(function* (key: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const tools = yield* (yield* Nix).tools;

	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(path.join(tools, "bin", "ssh-keygen"), ["-l", "-f", "/dev/stdin"], {
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
