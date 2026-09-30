import { Schema } from "effect";

export const OperatingSystem = Schema.Literals(["macos", "nixos"]);

export type OperatingSystem = typeof OperatingSystem.Type;
