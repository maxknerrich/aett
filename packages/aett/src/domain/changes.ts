import { Option } from "effect";
import { explicitSource } from "./packages.ts";

/** What a new system changes on a machine: `nix store diff-closures`' lines, and the commands it removes and adds. */
export interface Changes {
	readonly diff: string;
	readonly removed: ReadonlyArray<string>;
	readonly added: ReadonlyArray<string>;
}

// diff-closures' line for a system itself, such as darwin-system or nixos-system-hestia.
const isSystem = (name: string) => name.endsWith("-system") || name.startsWith("nixos-system-");

/**
 * The changes as the operator reads them before switching: the commands the
 * new system removes and adds, then what changes about the packages
 * `declared` names and the system itself, and how many other packages change
 * underneath. Empty when nothing changes.
 */
export const describeChanges = (
	{ diff, removed, added }: Changes,
	declared: ReadonlyArray<string>,
) => {
	const names = new Set(
		declared.map((name) =>
			Option.match(explicitSource(name), { onNone: () => name, onSome: (sourced) => sourced.name }),
		),
	);

	const lines = diff
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

	const own = lines.filter((line) => {
		const name = line.slice(0, line.indexOf(":"));

		return names.has(name) || isSystem(name);
	});

	const others = lines.length - own.length;

	return [
		...(removed.length === 0 ? [] : [`Commands it removes: ${removed.join(", ")}`]),
		...(added.length === 0 ? [] : [`Commands it adds: ${added.join(", ")}`]),
		...own,
		...(others === 0 ? [] : [`…and ${others} other package${others === 1 ? "" : "s"} underneath.`]),
	]
		.map((line) => `  ${line}`)
		.join("\n");
};
