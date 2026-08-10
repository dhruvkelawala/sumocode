import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type ChildSpawnPlan = {
	readonly args: readonly string[];
};

const require = createRequire(import.meta.url);
const { buildChildSpawnPlan } = require("./spawn-child.mjs") as {
	buildChildSpawnPlan(env: NodeJS.ProcessEnv, argv: readonly string[]): ChildSpawnPlan | undefined;
};

let roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(bundleMtime?: number, sourceMtime?: number): string {
	const root = mkdtempSync(join(tmpdir(), "sumocode-spawn-child-"));
	roots.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "dist", "extension"), { recursive: true });
	const source = join(root, "src", "extension.ts");
	const bundle = join(root, "dist", "extension", "sumocode-extension.bundle.mjs");
	writeFileSync(source, "export default () => {};\n");
	if (bundleMtime !== undefined) {
		writeFileSync(bundle, "export default () => {};\n");
		const sourceTime = sourceMtime ?? bundleMtime - 100;
		utimesSync(source, sourceTime, sourceTime);
		utimesSync(bundle, bundleMtime, bundleMtime);
	}
	return root;
}

function plan(root: string, extra: NodeJS.ProcessEnv = {}) {
	return buildChildSpawnPlan({ PI_BIN: "/usr/local/bin/pi", SUMOCODE_ROOT_DIR: root, ...extra }, ["--offline"]);
}

describe("buildChildSpawnPlan extension entry", () => {
	it("uses a fresh extension bundle", () => {
		const root = makeRoot(Date.now() / 1000 + 10);
		expect(plan(root)?.args[3]).toBe(join(root, "dist", "extension", "sumocode-extension.bundle.mjs"));
	});

	it.each([
		["missing bundle", undefined, {}],
		["stale bundle", Date.now() / 1000 - 10, {}, Date.now() / 1000 + 10],
		["explicit source override", Date.now() / 1000 + 10, { SUMOCODE_EXTENSION_BUNDLE: "0" }],
	] as const)("uses source for %s", (_label, bundleMtime, extra, sourceMtime?: number) => {
		const root = makeRoot(bundleMtime, sourceMtime);
		expect(plan(root, extra)?.args[3]).toBe(join(root, "src", "extension.ts"));
	});
});
