import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type ChildSpawnPlan = {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
};

const require = createRequire(import.meta.url);
// SAFETY: spawn-child.mjs is this package's own module; the export shape is
// exercised directly by these tests.
const { buildChildSpawnPlan } = require("./spawn-child.mjs") as {
	buildChildSpawnPlan(env: NodeJS.ProcessEnv, argv: readonly string[]): ChildSpawnPlan | undefined;
};

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "sumocode-spawn-child-"));
	roots.push(root);
	return root;
}

function plan(root: string, extra: NodeJS.ProcessEnv = {}) {
	return buildChildSpawnPlan({
		PI_BIN: "/usr/local/bin/pi",
		SUMOCODE_ROOT_DIR: root,
		SUMOCODE_PROJECT_CWD: join(root, "project"),
		...extra,
	}, ["--offline"]);
}

describe("buildChildSpawnPlan extension entry", () => {
	it("routes the RPC child through the stable import-fallback shim", () => {
		const root = makeRoot();
		const result = plan(root);
		expect(result?.args[3]).toBe(join(root, "src", "extension-entry.ts"));
		expect(result?.cwd).toBe(join(root, "project"));
		expect(result?.env).toMatchObject({ SUMOCODE_RPC_CHILD: "1", SUMO_TUI: "0" });
	});

	it("uses source directly for the explicit bundle override", () => {
		const root = makeRoot();
		expect(plan(root, { SUMOCODE_EXTENSION_BUNDLE: "0" })?.args[3]).toBe(join(root, "src", "extension.ts"));
	});

	it("returns no plan when PI_BIN is absent", () => {
		expect(buildChildSpawnPlan({}, [])).toBeUndefined();
	});
});
