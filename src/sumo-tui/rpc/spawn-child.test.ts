import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type ChildSpawnPlan = {
	readonly args: readonly string[];
};

const require = createRequire(import.meta.url);
const { buildChildSpawnPlan, extensionInputsHash } = require("./spawn-child.mjs") as {
	buildChildSpawnPlan(env: NodeJS.ProcessEnv, argv: readonly string[]): ChildSpawnPlan | undefined;
	extensionInputsHash(root: string): string;
};

let roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(bundleState: "fresh" | "stale" | "missing"): string {
	const root = mkdtempSync(join(tmpdir(), "sumocode-spawn-child-"));
	roots.push(root);
	mkdirSync(join(root, "src", "assets"), { recursive: true });
	mkdirSync(join(root, "src", "background-tasks"), { recursive: true });
	mkdirSync(join(root, "dist", "extension"), { recursive: true });
	writeFileSync(join(root, "src", "extension.ts"), "export default () => {};\n");
	writeFileSync(join(root, "src", "assets", "sumo-face.ans"), "face\n");
	writeFileSync(join(root, "src", "background-tasks", "bounded-terminal-runner.mjs"), "runner\n");
	if (bundleState !== "missing") {
		writeFileSync(join(root, "dist", "extension", "sumocode-extension.bundle.mjs"), "export default () => {};\n");
		writeFileSync(
			join(root, "dist", "extension", ".inputs-hash"),
			bundleState === "fresh" ? `${extensionInputsHash(root)}\n` : "stale\n",
		);
	}
	return root;
}

function plan(root: string, extra: NodeJS.ProcessEnv = {}) {
	return buildChildSpawnPlan({ PI_BIN: "/usr/local/bin/pi", SUMOCODE_ROOT_DIR: root, ...extra }, ["--offline"]);
}

describe("buildChildSpawnPlan extension entry", () => {
	it("uses a content-fresh extension bundle", () => {
		const root = makeRoot("fresh");
		expect(plan(root)?.args[3]).toBe(join(root, "dist", "extension", "sumocode-extension.bundle.mjs"));
	});

	it.each([
		["missing bundle", "missing", {}],
		["stale bundle", "stale", {}],
		["explicit source override", "fresh", { SUMOCODE_EXTENSION_BUNDLE: "0" }],
	] as const)("uses source for %s", (_label, bundleState, extra) => {
		const root = makeRoot(bundleState);
		expect(plan(root, extra)?.args[3]).toBe(join(root, "src", "extension.ts"));
	});
});
