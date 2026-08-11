import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type ChildSpawnPlan = {
	readonly args: readonly string[];
};

const require = createRequire(import.meta.url);
const { buildChildSpawnPlan, extensionInputsHash, extensionOutputsHash, normalizeHashPath } = require("./spawn-child.mjs") as {
	buildChildSpawnPlan(env: NodeJS.ProcessEnv, argv: readonly string[]): ChildSpawnPlan | undefined;
	extensionInputsHash(root: string): string;
	extensionOutputsHash(root: string): string;
	normalizeHashPath(path: string): string;
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
	mkdirSync(join(root, "dist", "extension", "assets"), { recursive: true });
	mkdirSync(join(root, "scripts", "lib"), { recursive: true });
	writeFileSync(join(root, "src", "extension.ts"), "export default () => {};\n");
	writeFileSync(join(root, "src", "assets", "sumo-face.ans"), "face\n");
	writeFileSync(join(root, "src", "background-tasks", "bounded-terminal-runner.mjs"), "runner\n");
	writeFileSync(join(root, "scripts", "build-extension.mjs"), "// recipe\n");
	writeFileSync(join(root, "scripts", "lib", "extension-bundle.mjs"), "// recipe helper\n");
	if (bundleState !== "missing") {
		writeFileSync(join(root, "dist", "extension", "sumocode-extension.bundle.mjs"), "export default () => {};\n");
		writeFileSync(join(root, "dist", "extension", "assets", "sumo-face.ans"), "face\n");
		writeFileSync(join(root, "dist", "extension", "bounded-terminal-runner.mjs"), "runner\n");
		writeFileSync(
			join(root, "dist", "extension", ".inputs-hash"),
			bundleState === "fresh" ? `${extensionInputsHash(root)}\n` : "stale\n",
		);
		writeFileSync(join(root, "dist", "extension", ".outputs-hash"), `${extensionOutputsHash(root)}\n`);
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

	it.each([
		["bundle", "sumocode-extension.bundle.mjs"],
		["copied asset", join("assets", "sumo-face.ans")],
	] as const)("uses source when the committed %s is corrupt", (_label, output) => {
		const root = makeRoot("fresh");
		writeFileSync(join(root, "dist", "extension", output), "corrupt\n");
		expect(plan(root)?.args[3]).toBe(join(root, "src", "extension.ts"));
	});

	it.each([
		["build recipe", join("scripts", "build-extension.mjs")],
		["build recipe helper", join("scripts", "lib", "extension-bundle.mjs")],
	] as const)("uses source when the %s changes", (_label, input) => {
		const root = makeRoot("fresh");
		writeFileSync(join(root, input), "// changed recipe\n");
		expect(plan(root)?.args[3]).toBe(join(root, "src", "extension.ts"));
	});

	it("normalizes Windows separators in portable hash paths", () => {
		expect(normalizeHashPath("src\\nested\\extension.ts")).toBe("src/nested/extension.ts");
	});
});
