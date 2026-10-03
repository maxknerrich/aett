import { Option, Schema } from "effect";
import { Platform } from "./pins.ts";

/** One OpenSSH public key line: type, base64 blob and an optional comment. */
export const SshPublicKey = Schema.String.check(
	Schema.isPattern(
		/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/,
		{ expected: 'an OpenSSH public key such as "ssh-ed25519 AAAA… comment"' },
	),
);

/** An age X25519 public key, which secrets are encrypted to. */
export const AgePublicKey = Schema.String.check(
	Schema.isPattern(/^age1[02-9ac-hj-np-z]{58}$/, {
		expected: 'an age public key such as "age1…"',
	}),
);

const isAgePublicKey = Schema.is(AgePublicKey);

/** Reads the key pair from age-keygen's output: the `# public key: age1…` comment and the `AGE-SECRET-KEY-1…` line. */
export const ageKeyPair = (output: string) => {
	const publicKey = /^# public key: (\S+)$/m.exec(output)?.[1];
	const secretKey = /^AGE-SECRET-KEY-1[0-9A-Z]+$/m.exec(output)?.[0];

	return publicKey !== undefined && secretKey !== undefined && isAgePublicKey(publicKey)
		? Option.some({ publicKey, secretKey })
		: Option.none();
};

/**
 * state/operator.json: the operators' public keys. Each SSH key logs in to
 * the machines as root; each age key can decrypt the secrets aett makes.
 */
export const Operator = Schema.Struct({
	sshKeys: Schema.NonEmptyArray(SshPublicKey),
	ageKeys: Schema.NonEmptyArray(AgePublicKey),
});

export interface Operator extends Schema.Schema.Type<typeof Operator> {}

/** state/<name>/machine.json: aett's decisions about one machine. */
export const MachineRecord = Schema.Struct({
	// The disk install erased, by its /dev/disk/by-id/ path.
	disk: Schema.optionalKey(Schema.String),
	// A NAS: the disks of each pool, by their /dev/disk/by-id/ paths, chosen at install.
	pools: Schema.optionalKey(
		Schema.Struct({ root: Schema.Array(Schema.String), tank: Schema.Array(Schema.String) }),
	),
	// A Mac's platform, which a NixOS machine's hardware report says instead.
	system: Schema.optionalKey(Platform),
	// Whether the installed btrfs partition is inside LUKS; absent means it is not.
	encrypted: Schema.optionalKey(Schema.Boolean),
	installed: Schema.optionalKey(Schema.Boolean),
	// A machine that runs VMs: its guests' subnet, 10.100.<n>.0/24.
	subnet: Schema.optionalKey(Schema.String),
	// A VM: the machine it was placed on and its address on that machine's subnet.
	host: Schema.optionalKey(Schema.String),
	address: Schema.optionalKey(Schema.String),
	// A VM with a home: the ports on its host that reach its SSH and its mosh range.
	forwards: Schema.optionalKey(
		Schema.Struct({ ssh: Schema.Int, mosh: Schema.Tuple([Schema.Int, Schema.Int]) }),
	),
	// The machine on the tailnet, once it joined: its IPv4 address, its name there and its node id.
	tailnet: Schema.optionalKey(Schema.String),
	tailnetName: Schema.optionalKey(Schema.String),
	node: Schema.optionalKey(Schema.String),
	// The tag aett last gave its node, its role's, which aett changes with the role.
	tag: Schema.optionalKey(Schema.String),
	// An encrypted machine's initrd on the tailnet, which aett machine unlock reaches.
	unlock: Schema.optionalKey(
		Schema.Struct({ tailnet: Schema.String, tailnetName: Schema.String, node: Schema.String }),
	),
	// A Mac: the public half of the age key aett made for it, which its secrets are encrypted to.
	age: Schema.optionalKey(AgePublicKey),
	// A Mac: whether Determinate Nix runs it, whose settings nix-darwin leaves to a file of their own.
	determinate: Schema.optionalKey(Schema.Boolean),
	// A Mac: whether it runs the Tailscale app, which aett leaves to it.
	tailscaleApp: Schema.optionalKey(Schema.Boolean),
	// A Mac: whether the operator agreed to remove the Homebrew apps fleet.ts doesn't list.
	zap: Schema.optionalKey(Schema.Boolean),
	// When the one-time Tailscale key aett minted for the machine stops working, if it hasn't joined yet.
	tailscaleKeyExpires: Schema.optionalKey(Schema.String),
});

export interface MachineRecord extends Schema.Schema.Type<typeof MachineRecord> {}

/** What state holds for one declared machine: its record, whether its hardware report exists, and its platform. */
export interface MachineState extends MachineRecord {
	readonly facts: boolean;
	/** From its hardware report, its record, or its host's report for a VM; none until aett knows. */
	readonly platform?: Platform | undefined;
}

/**
 * State read from the fleet repository, with machines keyed by name: every
 * declared machine, and every machine state still records after fleet.ts
 * dropped it.
 */
export interface State {
	readonly operator: Operator;
	readonly machines: ReadonlyMap<string, MachineState>;
}
