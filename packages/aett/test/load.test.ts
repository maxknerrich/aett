import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { findFleet } from "../src/workflows/load.ts";

describe("findFleet", () => {
	it("finds the nearest fleet.ts from a directory upwards, and none outside a fleet", async () => {
		const { fleet, inside, outside } = await Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "aett-test-" });
			const home = path.join(scratch, "home");
			const nested = path.join(home, "state", "box");

			yield* fs.makeDirectory(nested, { recursive: true });
			yield* fs.writeFileString(path.join(home, "fleet.ts"), "");

			return { fleet: home, inside: yield* findFleet(nested), outside: yield* findFleet(scratch) };
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

		expect(inside).toEqual(Option.some(fleet));
		expect(outside).toEqual(Option.none());
	});
});
