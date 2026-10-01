import { Option, Schema } from "effect";

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

/** state/<name>/machine.json: aett's decisions about one machine, written by install. */
export const MachineRecord = Schema.Struct({
	disk: Schema.optionalKey(Schema.String),
	// Whether the installed btrfs partition is inside LUKS; absent means it is not.
	encrypted: Schema.optionalKey(Schema.Boolean),
	installed: Schema.optionalKey(Schema.Boolean),
});

export interface MachineRecord extends Schema.Schema.Type<typeof MachineRecord> {}

/** What state holds for one declared machine: its record and whether its hardware report exists. */
export interface MachineState extends MachineRecord {
	readonly facts: boolean;
}

/** State read from the fleet repository, with machines keyed by name. */
export interface State {
	readonly operator: Operator;
	readonly machines: ReadonlyMap<string, MachineState>;
}
