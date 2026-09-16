import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|testing)(?:\/|$))/u;
const PLATFORM_BARREL = /^@effect\/platform(?:-[^/]+)?$/u;
const PLAIN_EFFECT_FILES = new Set([
	"src/activity/persistence.ts",
	"src/background-tasks/process-tree.ts",
	"src/background-tasks/task-store.ts",
	"src/child-protocol.ts",
	"src/native/main.ts",
	"src/sumo-tui/rpc/spawn-child.mjs",
	"sumo-rpc-host.js",
]);
const PLAIN_EFFECT_DIRECTORIES = [
	"src/cathedral/",
	"src/sumo-tui/cathedral/",
	"src/sumo-tui/input/",
	"src/sumo-tui/layout/",
	"src/sumo-tui/render/",
	"src/sumo-tui/transcript/",
	"src/sumo-tui/widgets/",
];

function repositoryPath(filename: string): string {
	// Oxlint supplies an absolute filename. Anchor at the owned source root so a
	// checkout beneath an ancestor named tests/ cannot disable production rules.
	const normalized = filename.replaceAll("\\", "/");
	for (const root of ["src", "test", "scripts", "tools"]) {
		const marker = `/${root}/`;
		const index = normalized.lastIndexOf(marker);
		if (index >= 0) return normalized.slice(index + 1);
		if (normalized.startsWith(`${root}/`)) return normalized;
	}
	if (normalized.endsWith("/sumo-rpc-host.js")) return "sumo-rpc-host.js";
	return normalized;
}

function isEffectImport(source: string): boolean {
	return source === "effect" || source.startsWith("effect/") || source.startsWith("@effect/");
}

function isPlainEffectZone(filename: string): boolean {
	return PLAIN_EFFECT_FILES.has(filename) || PLAIN_EFFECT_DIRECTORIES.some((directory) => filename.startsWith(directory));
}

function restriction(source: string, isTestFile: boolean, plainEffectZone: boolean): "forbiddenZone" | "platformBarrel" | "rootBarrel" | "testOnly" | "unstable" | undefined {
	if (source === "effect") return "rootBarrel";
	if (PLATFORM_BARREL.test(source)) return "platformBarrel";
	if (!isTestFile && plainEffectZone && isEffectImport(source)) return "forbiddenZone";
	if (!isTestFile && (source === "effect/testing" || source.startsWith("effect/testing/"))) return "testOnly";
	if (!isTestFile && (source === "effect/unstable" || source.startsWith("effect/unstable/"))) return "unstable";
	return undefined;
}

/** Keep heavy, test-only, and unapproved Effect modules out of production imports. */
export const noRestrictedImportsRule = defineRule({
	meta: {
		type: "problem",
		docs: { description: "Enforce SumoCode's Effect import boundary." },
		messages: {
			forbiddenZone: "Effect is not allowed in launcher, rendering, or plain security primitives.",
			rootBarrel: 'Import Effect through a deep subpath such as "effect/Effect", never the root barrel.',
			platformBarrel: "Import platform packages through a deep subpath, never a @effect/platform-* root barrel.",
			testOnly: "Effect testing modules are test-only and cannot be imported by production code.",
			unstable: "Unstable Effect modules require explicit production approval and a documented lint suppression.",
		},
	},
	create(context) {
		const filename = repositoryPath(context.filename);
		const isTestFile = TEST_FILE.test(filename);
		const plainEffectZone = isPlainEffectZone(filename);
		const check = (node: ESTree.Node, source: string): void => {
			const messageId = restriction(source, isTestFile, plainEffectZone);
			if (messageId) context.report({ node, messageId });
		};

		return {
			ImportDeclaration(node) {
				check(node.source, node.source.value);
			},
			ExportNamedDeclaration(node) {
				if (node.source) check(node.source, node.source.value);
			},
			ExportAllDeclaration(node) {
				check(node.source, node.source.value);
			},
			ImportExpression(node) {
				if (node.source.type === "Literal" && typeof node.source.value === "string") {
					check(node.source, node.source.value);
				}
			},
		};
	},
});
