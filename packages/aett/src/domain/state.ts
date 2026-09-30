import { Schema } from "effect";

/** One OpenSSH public key line: type, base64 blob and an optional comment. */
export const SshPublicKey = Schema.String.check(
	Schema.isPattern(
		/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/,
		{ expected: 'an OpenSSH public key such as "ssh-ed25519 AAAA… comment"' },
	),
);

/** state/operator.json: the operator's public keys. */
export const Operator = Schema.Struct({
	sshKeys: Schema.NonEmptyArray(SshPublicKey),
});

export interface Operator extends Schema.Schema.Type<typeof Operator> {}

/** state/<name>/machine.json: aett's decisions about one machine, written by install. */
export const MachineRecord = Schema.Struct({
	disk: Schema.optionalKey(Schema.String),
	installed: Schema.optionalKey(Schema.Boolean),
});

export interface MachineRecord extends Schema.Schema.Type<typeof MachineRecord> {}

/** What state holds for one declared machine: its record and whether its facter report exists. */
export interface MachineState extends MachineRecord {
	readonly facts: boolean;
}

/** State read from the fleet repository, with machines keyed by name. */
export interface State {
	readonly operator: Operator;
	readonly machines: ReadonlyMap<string, MachineState>;
}
