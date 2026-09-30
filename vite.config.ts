import { defineConfig } from "vite-plus";

const agentTooling = [".agents/**", ".claude/**", ".codex/**"];

const antiSlop = "tools/oxlint/anti-slop";

export default defineConfig({
	resolve: {
		conditions: ["development", "module", "node"],
	},
	lint: {
		plugins: ["eslint", "oxc", "unicorn", "typescript"],
		jsPlugins: [
			{ name: "anti-slop", specifier: `./${antiSlop}/index.ts` },
			{ name: "anti-slop-effect", specifier: `./${antiSlop}/effect/index.ts` },
		],
		categories: {
			suspicious: "warn",
			perf: "warn",
		},
		rules: {
			"oxc/no-accumulating-spread": "error",
			"anti-slop/no-array-filter-map": "error",
			"anti-slop/no-reduce-accumulator-copy": "error",
			"anti-slop/no-chained-type-assertions": "error",
			"anti-slop/no-conditional-empty-object-spread": "error",
			"anti-slop/no-known-value-widening": "error",
			"anti-slop/no-module-mocking": "error",
			"anti-slop/no-object-parameters": "error",
			"anti-slop/no-reflect-apply": "error",
			"anti-slop/no-reflect-get": "error",
			"anti-slop/no-runtime-typeof": "error",
			"anti-slop/no-shape-in-symbol-names": "error",
			"anti-slop/no-unknown-parameters": "error",
			"anti-slop/no-unknown-returns": "error",
			"anti-slop/no-unknown-type-aliases": "error",
			"anti-slop/no-unsafe-dictionary-type": "error",
			"anti-slop/no-widen-then-assert": "error",
			"anti-slop/require-readable-spacing": "error",
			"anti-slop/require-safety-comment-for-type-assertion": "error",
			"anti-slop-effect/no-manual-effect-error-tag": "error",
			"anti-slop-effect/no-manual-tag-comparison": "error",
			"anti-slop-effect/no-manual-tagged-construction": "error",
			"anti-slop-effect/no-service-constructor-imports": "error",
			"anti-slop-effect/prefer-effect-match": "error",
		},
		options: {
			typeAware: true,
			typeCheck: true,
		},
		ignorePatterns: ["**/dist/**", ".repos/**", ...agentTooling, `${antiSlop}/**`],
	},
	fmt: {
		useTabs: true,
		ignorePatterns: [
			"docs/**",
			"AGENTS.md",
			"README.md",
			".repos/**",
			...agentTooling,
			`${antiSlop}/**`,
		],
	},
	test: {
		environment: "node",
		include: ["packages/*/test/**/*.test.ts"],
	},
	staged: {
		"*": "vp fmt --no-error-on-unmatched-pattern",
	},
});
