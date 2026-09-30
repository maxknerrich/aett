import { defineConfig } from "vite-plus";

export default defineConfig({
	run: {
		tasks: {
			start: {
				command: "node dist/cli/main.js",
				dependsOn: ["build"],
				cache: false,
			},
		},
	},
	pack: {
		entry: ["src/index.ts", "src/cli/main.ts"],
		format: "esm",
		platform: "node",
		target: "node24",
		outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
		dts: true,
		sourcemap: true,
	},
});
