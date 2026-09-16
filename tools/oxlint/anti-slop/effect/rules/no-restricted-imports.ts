import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const PLATFORM_BARREL = /^@effect\/platform-[^/]+$/u;

function restriction(source: string, isTestFile: boolean): "platformBarrel" | "rootBarrel" | "testOnly" | "unstable" | undefined {
	if (source === "effect") return "rootBarrel";
	if (PLATFORM_BARREL.test(source)) return "platformBarrel";
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
			rootBarrel: 'Import Effect through a deep subpath such as "effect/Effect", never the root barrel.',
			platformBarrel: "Import platform packages through a deep subpath, never a @effect/platform-* root barrel.",
			testOnly: "Effect testing modules are test-only and cannot be imported by production code.",
			unstable: "Unstable Effect modules require explicit production approval and a documented lint suppression.",
		},
	},
	create(context) {
		const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));
		const check = (node: ESTree.Node, source: string): void => {
			const messageId = restriction(source, isTestFile);
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
