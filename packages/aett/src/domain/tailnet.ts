import { isIP } from "node:net";
import { Option, Result, Schema } from "effect";
import { findNodeAtLocation, type Node, type ParseError, parse, parseTree } from "jsonc-parser";
import type { Fleet } from "./fleet.ts";
import type { Grant } from "./plugin.ts";

/** The tag a machine joins the tailnet with: its role's. */
export const tagOf = (role: string) => `tag:${role}`;

/** A node on the tailnet, as it says itself: its IPv4 address, its name there and its tags. */
export interface Joined {
	readonly tailnet: string;
	readonly tailnetName: string;
	readonly tags: ReadonlyArray<string>;
}

// What `tailscale status --json` says about the node itself.
const SelfStatus = Schema.fromJsonString(
	Schema.Struct({
		BackendState: Schema.String,
		Self: Schema.Struct({
			DNSName: Schema.String,
			TailscaleIPs: Schema.NullOr(Schema.Array(Schema.String)),
			Tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
		}),
	}),
);

/** The node `tailscale status --json` describes, once it is on the tailnet. */
export const joinedFrom = (printed: string): Option.Option<Joined> =>
	Option.flatMap(
		Schema.decodeUnknownOption(SelfStatus)(printed.trim()),
		({ BackendState, Self }) => {
			const tailnet = (Self.TailscaleIPs ?? []).find((ip) => isIP(ip) === 4);
			const tailnetName = Self.DNSName.replace(/\.$/, "");

			return BackendState === "Running" && tailnet !== undefined && tailnetName !== ""
				? Option.some({ tailnet, tailnetName, tags: Self.Tags ?? [] })
				: Option.none();
		},
	);

// The tags of the named machines. A Mac runs the Tailscale app as its owner's device and has none.
const tagsOf = (fleet: Fleet, names: ReadonlyArray<string>) =>
	[
		...new Set(
			fleet.machines.flatMap(({ name, role, kind }) =>
				names.includes(name) && kind !== "macos" ? [tagOf(role)] : [],
			),
		),
	].toSorted();

// How a grant names the named machines: by tag, and Macs, the owner's devices, as autogroup:member.
const selectorsOf = (fleet: Fleet, names: ReadonlyArray<string>) => [
	...tagsOf(fleet, names),
	...(fleet.machines.some(({ name, kind }) => names.includes(name) && kind === "macos")
		? ["autogroup:member"]
		: []),
];

/**
 * The grants the tailnet's policy needs so each plugin's clients and
 * instances reach its instances' endpoints, and the whole tailnet its web
 * endpoints.
 */
export const grantsFor = (fleet: Fleet): ReadonlyArray<Grant> =>
	[...fleet.services.values()].flatMap(({ plugin, instances, clients }) => {
		const endpoints = Object.values(plugin.endpoints ?? {});

		const ports = (web: boolean) =>
			endpoints.flatMap((endpoint) =>
				(endpoint.web === true) === web ? [`tcp:${endpoint.port}`] : [],
			);

		const dst = selectorsOf(fleet, instances);

		return [
			{ src: selectorsOf(fleet, [...instances, ...clients]), dst, ip: ports(false) },
			{ src: ["*"], dst, ip: ports(true) },
		].filter(({ src, ip }) => ip.length > 0 && src.length > 0 && dst.length > 0);
	});

/** What the fleet needs from the tailnet's policy: the tags its machines join with and the grants between them. */
export interface PolicyNeeds {
	readonly tags: ReadonlyArray<string>;
	readonly grants: ReadonlyArray<Grant>;
}

/** The fleet's needs: each NixOS machine's role tag and the plugins' grants. */
export const policyNeeds = (fleet: Fleet): PolicyNeeds => ({
	tags: tagsOf(
		fleet,
		fleet.machines.map(({ name }) => name),
	),
	grants: grantsFor(fleet),
});

// Who owns a tag aett adds: the tailnet's admins, who approve each machine that joins with it.
const owners = ["autogroup:admin"];

// The parts of a policy aett reads. Everything else stays as it is.
const Policy = Schema.Struct({
	tagOwners: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	grants: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				src: Schema.optionalKey(Schema.Array(Schema.String)),
				dst: Schema.optionalKey(Schema.Array(Schema.String)),
				ip: Schema.optionalKey(Schema.Array(Schema.String)),
				srcPosture: Schema.optionalKey(Schema.Unknown),
				via: Schema.optionalKey(Schema.Unknown),
			}),
		),
	),
});

// Whether the selectors `have` cover every one of `want`.
const covers = (have: ReadonlyArray<string> | undefined, want: ReadonlyArray<string>) =>
	have !== undefined && (have.includes("*") || want.every((selector) => have.includes(selector)));

// A list of strings or a grant on one line, as people write them in a policy.
const inline = (value: ReadonlyArray<string> | Grant): string =>
	Array.isArray(value)
		? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
		: `{${Object.entries(value)
				.map(([key, items]) => `${JSON.stringify(key)}: ${inline(items)}`)
				.join(", ")}}`;

// The whitespace that starts the line `offset` is on.
const indentAt = (text: string, offset: number) =>
	/^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", offset - 1) + 1))?.[0] ?? "";

// Adds `entry` to the object or array `container` on a line of its own, after its last one and
// indented alike, keeping a trailing comma where the policy has them.
const append = (text: string, container: Node, entry: string, unit: string) => {
	const last = container.children?.at(-1);

	if (last === undefined) {
		const indent = indentAt(text, container.offset);
		const inside = container.offset + 1;

		return `${text.slice(0, inside)}\n${indent}${unit}${entry}\n${indent}${text.slice(inside).trimStart()}`;
	}

	const end = last.offset + last.length;
	const comma = /^\s*,/.exec(text.slice(end))?.[0] ?? "";
	const after = end + comma.length;
	const newline = text.indexOf("\n", after);

	// After a comment that ends the last one's line, which stays with it.
	const at = newline !== -1 && /^\s*(\/\/.*)?$/.test(text.slice(after, newline)) ? newline : after;

	const indent = indentAt(text, last.offset);

	return comma === ""
		? `${text.slice(0, end)},${text.slice(end, at)}\n${indent}${entry}${text.slice(at)}`
		: `${text.slice(0, at)}\n${indent}${entry},${text.slice(at)}`;
};

// Adds `entry` to the policy's `key`, which it makes at the top level when the policy lacks it.
const addEntry = (text: string, key: "tagOwners" | "grants", entry: string) => {
	const unit = text.includes("\n\t") ? "\t" : "  ";
	const root = parseTree(text, [], { allowTrailingComma: true });

	if (root === undefined) return text;

	const container = findNodeAtLocation(root, [key]);

	if (container !== undefined) return append(text, container, entry, unit);

	const indent = Option.match(Option.fromUndefinedOr(root.children?.[0]), {
		onNone: () => unit,
		onSome: (first) => indentAt(text, first.offset),
	});

	const [open, close] = key === "grants" ? ["[", "]"] : ["{", "}"];

	return append(text, root, `"${key}": ${open}\n${indent}${unit}${entry}\n${indent}${close}`, unit);
};

/**
 * Adds what `needs` lacks to `text`, the tailnet's policy as HuJSON: each
 * missing tag, owned by the admins, and each grant no existing one covers,
 * each on a line of its own. Everything else stays as it was, comments
 * included; aett never removes anything. Returns the new policy, or none when
 * nothing lacks.
 */
export const mergePolicy = (
	text: string,
	needs: PolicyNeeds,
): Result.Result<Option.Option<string>, string> => {
	const errors: Array<ParseError> = [];
	const parsed: unknown = parse(text, errors, { allowTrailingComma: true });

	const policy = Option.filter(
		Schema.decodeUnknownOption(Policy)(parsed),
		() => errors.length === 0,
	);

	if (Option.isNone(policy)) return Result.fail("The tailnet's policy isn't HuJSON aett can read.");

	const { tagOwners = {}, grants = [] } = policy.value;

	const tags = needs.tags.filter((tag) => !(tag in tagOwners));

	// A grant limited to some devices' posture or to routes through some nodes doesn't count.
	const missing = needs.grants.filter(
		(want) =>
			!grants.some(
				(have) =>
					have.srcPosture === undefined &&
					have.via === undefined &&
					covers(have.src, want.src) &&
					covers(have.dst, want.dst) &&
					covers(have.ip, want.ip),
			),
	);

	if (tags.length === 0 && missing.length === 0) return Result.succeed(Option.none());

	const withTags = tags.reduce(
		(current, tag) => addEntry(current, "tagOwners", `${JSON.stringify(tag)}: ${inline(owners)}`),
		text,
	);

	return Result.succeed(
		Option.some(
			missing.reduce((current, grant) => addEntry(current, "grants", inline(grant)), withTags),
		),
	);
};

/** The policy lines for the operator to add by hand: the tags, owned by the admins, and the grants. */
export const policySnippet = (needs: PolicyNeeds) =>
	[
		...(needs.tags.length === 0
			? []
			: [
					`"tagOwners": {`,
					...needs.tags.map((tag) => `\t${JSON.stringify(tag)}: ${inline(owners)},`),
					`},`,
				]),
		...(needs.grants.length === 0
			? []
			: [`"grants": [`, ...needs.grants.map((grant) => `\t${inline(grant)},`), `],`]),
	].join("\n");
