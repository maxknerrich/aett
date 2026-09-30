import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts", "src/darwin/index.ts", "src/nixos/index.ts"],
		format: "esm",
		platform: "node",
		target: "node24",
		outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
		dts: true,
		sourcemap: true,
	},
});
