import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectories = [];

function runLint(filename, source, useRepositoryConfig = false) {
	const directory = mkdtempSync(useRepositoryConfig
		? resolve(root, ".sumocode-effect-lint-")
		: join(tmpdir(), "sumocode-effect-lint-"));
	temporaryDirectories.push(directory);
	if (!useRepositoryConfig) {
		symlinkSync(resolve(root, "node_modules"), join(directory, "node_modules"), "dir");
		writeFileSync(join(directory, "oxlint.config.ts"), `
import { defineConfig } from "oxlint";
export default defineConfig({
	jsPlugins: [{ name: "anti-slop-effect", specifier: ${JSON.stringify(resolve(root, "tools/oxlint/anti-slop/effect/index.ts"))} }],
	rules: { "anti-slop-effect/no-restricted-imports": "error" },
});
`);
	}
	const input = join(directory, filename);
	mkdirSync(dirname(input), { recursive: true });
	writeFileSync(input, source);
	const args = useRepositoryConfig ? [input] : ["--config", join(directory, "oxlint.config.ts"), input];
	const result = spawnSync(resolve(root, "node_modules/.bin/oxlint"), args, {
		cwd: root,
		encoding: "utf8",
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Effect import policy", () => {
	it("is enabled by the repository lint configuration", () => {
		const result = runLint("production.ts", 'import "effect";\n', true);

		expect(result.status).toBe(1);
		expect(result.output).toContain("Import Effect through a deep subpath");
	});

	it("rejects the generic platform package barrel", () => {
		const result = runLint("production.ts", 'import "@effect/platform";\n');

		expect(result.status).toBe(1);
		expect(result.output).toContain("Import platform packages through a deep subpath");
	});

	it("rejects heavyweight and unapproved Effect imports in production", () => {
		const result = runLint("production.ts", `
import * as Root from "effect";
export * from "@effect/platform-node";
export { arbitrary } from "effect/testing/FastCheck";
const encoding = import("effect/unstable/encoding/Ndjson");
void Root;
void encoding;
`);

		expect(result.status).toBe(1);
		expect(result.output).toContain("Import Effect through a deep subpath");
		expect(result.output).toContain("Import platform packages through a deep subpath");
		expect(result.output).toContain("Effect testing modules are test-only");
		expect(result.output).toContain("Unstable Effect modules require explicit production approval");
	});

	it("allows stable deep imports and test-only modules in tests", () => {
		const production = runLint("production.ts", `
import * as Effect from "effect/Effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
void Effect;
void NodeRuntime;
`);
		const test = runLint("subject.test.ts", `
import * as FastCheck from "effect/testing/FastCheck";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
void FastCheck;
void Ndjson;
`);
		const testSupport = runLint("test/integration/harness.ts", `
import * as FastCheck from "effect/testing/FastCheck";
void FastCheck;
`);

		expect(production.status, production.output).toBe(0);
		expect(test.status, test.output).toBe(0);
		expect(testSupport.status, testSupport.output).toBe(0);
	});
});
