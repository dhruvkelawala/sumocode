import { defineConfig } from "oxlint";

export default defineConfig({
	ignorePatterns: [
		".agent/**",
		".agents/**",
		".claude/**",
		".codex/**",
		".continue/**",
		".cursor/**",
		".gemini/**",
		".opencode/**",
		".pi/**",
		".roo/**",
		".windsurf/**",
		"tools/oxlint/anti-slop/**",
		"dist/**",
	],
	jsPlugins: [
		{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
	],
	rules: {
		"anti-slop/no-chained-type-assertions": "error",
		"anti-slop/no-conditional-empty-object-spread": "error",
		"anti-slop/no-known-value-widening": "error",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		// Schema-free codebase: Pi/RPC payloads are decoded by hand-rolled boundary
		// parsers. Per the anti-slop README, permit typeof checks inside type
		// predicates (the sanctioned decode pattern) while rejecting ad hoc checks.
		"anti-slop/no-runtime-typeof": ["error", { "allowInTypeGuards": true }],
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-unknown-parameters": "error",
		"anti-slop/no-unknown-returns": "error",
		"anti-slop/no-unknown-type-aliases": "error",
		"anti-slop/no-unsafe-dictionary-type": "error",
		"anti-slop/no-widen-then-assert": "error",
		"anti-slop/require-safety-comment-for-type-assertion": "error",
	},
});
