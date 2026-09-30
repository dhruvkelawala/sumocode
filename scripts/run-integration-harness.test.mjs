import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { HARNESS_OWNER_TOKEN_ENV_KEY } from "./lib/integration-harness-constants.mjs";
import { resolveHarnessRunPlan } from "./run-integration-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const runner = fileURLToPath(new URL("./run-integration-harness.mjs", import.meta.url));
const seamArgs = ["run", "test/integration/verification-harness.test.ts", "--fileParallelism=false"];
const roots = [];

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRoot(parent = join(root, "test/integration")) {
	const path = mkdtempSync(join(parent, "runner-selection-"));
	roots.push(path);
	return path;
}

function listFiles(args, env = process.env) {
	const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "list", ...args, "--filesOnly", "--json"], {
		cwd: root, env, encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout).map((entry) => relative(root, entry.file)).sort();
}

function publicCli(args, owned = false) {
	// Deny child processes: a regression cannot accidentally start the broad lane.
	return spawnSync(process.execPath, [
		"--permission", `--allow-fs-read=${root}`,
		...roots.map((path) => `--allow-fs-read=${realpathSync(path)}`), runner, ...args,
	], {
		cwd: root,
		env: owned ? { ...process.env, [HARNESS_OWNER_TOKEN_ENV_KEY]: "selection-test-owner" } : process.env,
		encoding: "utf8",
	});
}

it.each([
	["--bogus"], ["--file"], ["--file", ""], ["--file=test/integration/rpc-contract.test.ts"],
	["--"], ["--", "--", "--file", "test/integration/rpc-contract.test.ts"],
	["test/integration/rpc-contract.test.ts"], ["--fix"], ["--purge-evidence"],
	["--file", "test/integration/"], ["--file", "test/integration/*.test.ts"],
	["--file", "test/integration/rpc-contract.test.ts:1"], ["--file", "src/footer.test.ts"],
	["--file", "./test/integration/rpc-contract.test.ts"],
	["--file", "test/integration/../integration/rpc-contract.test.ts"],
	["--file", "test/integration/./rpc-contract.test.ts"],
	["--file", "test/integration//rpc-contract.test.ts"],
	["--file", "test/integration/rpc-contract.test.ts\n"],
	["--file", "test\\integration\\rpc-contract.test.ts"],
	["--file", "test/integration/!rpc-contract.test.ts"],
	["--file", "test/integration/[rpc].test.ts"],
	["--file", "test/integration/{rpc,other}.test.ts"],
	["--file", "test/integration/no-such-selected-case.test.ts"],
	["--file", "test/integration/rpc-contract.test.ts", "test/integration/native-contract.test.ts"],
	["--file", "test/integration/rpc-contract.test.ts", "--file", "test/integration/native-contract.test.ts"],
	["--file", "test/integration/rpc-contract.test.ts", "-t", "anything"],
	["--native-only", "--file", "test/integration/native-contract.test.ts"],
	["--file", "test/integration/native-contract.test.ts", "--native-only"],
	["--native-only", "--bogus"], ["--native-only", "--native-only"],
])("refuses invalid public CLI selectors before preflight or owner/process startup: %j", (...args) => {
	const result = publicCli(args);
	expect(result.status).toBe(2);
	expect(result.stderr).toContain("invalid integration selection:");
	expect(result.stderr).not.toContain("ERR_ACCESS_DENIED");
	expect(result.stdout).not.toMatch(/preflight|seam tests|integration tests|zero-orphan/);
});

it("refuses directory, absolute and symlink escape selectors in both owner paths", () => {
	const inside = fixtureRoot();
	const outside = fixtureRoot(tmpdir());
	writeFileSync(join(outside, "outside.test.ts"), "// file-only fixture\n");
	symlinkSync(join(outside, "outside.test.ts"), join(inside, "escape.test.ts"));
	symlinkSync(outside, join(inside, "escape-dir"), "dir");
	mkdirSync(join(inside, "directory.test.ts"));
	for (const selected of [
		join(root, "test/integration/rpc-contract.test.ts"),
		relative(root, join(inside, "escape.test.ts")),
		relative(root, join(inside, "escape-dir/outside.test.ts")),
		relative(root, join(inside, "directory.test.ts")),
	]) {
		for (const owned of [false, true]) {
			const result = publicCli(["--", "--file", selected], owned);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("invalid integration selection:");
			expect(result.stderr).not.toContain("ERR_ACCESS_DENIED");
			if (selected.includes("escape")) expect(result.stderr).toContain("resolves outside test/integration");
			expect(result.stdout).toBe("");
		}
	}
});

it("accepts a selected public CLI path up to the permission-denied owner re-exec, without app startup", () => {
	const result = publicCli(["--", "--file", "test/integration/rpc-contract.test.ts"]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("ERR_ACCESS_DENIED");
	expect(result.stderr).toContain("ChildProcess");
	expect(result.stderr).not.toContain("invalid integration selection:");
	expect(result.stdout).toBe("");
});

it("preserves default and native-only execution plans, including pnpm's delimiter", async () => {
	for (const args of [[], ["--native-only"], ["--", "--native-only"]]) {
		const nativeOnly = args.includes("--native-only");
		await expect(resolveHarnessRunPlan(args)).resolves.toEqual({
			nativeOnly,
			selectedFile: undefined,
			seamArgs: nativeOnly ? null : seamArgs,
			integrationArgs: nativeOnly
				? ["run", "test/integration/native-", "--fileParallelism=false"]
				: ["run", "test/integration/", "--fileParallelism=false", "--exclude", "test/integration/verification-harness.test.ts"],
		});
	}
});

it("plans the mandatory seam plus only the explicit existing selected file", async () => {
	const selected = "test/integration/rpc-contract.test.ts";
	const expected = {
		nativeOnly: false,
		selectedFile: selected,
		seamArgs,
		integrationArgs: ["run", selected, "--fileParallelism=false"],
	};
	await expect(resolveHarnessRunPlan(["--file", selected])).resolves.toEqual(expected);
	await expect(resolveHarnessRunPlan(["--", "--file", selected])).resolves.toEqual(expected);
});

it("lists exactly the selected target with actual Vitest semantics despite substring lookalikes", async () => {
	const inside = fixtureRoot();
	const selected = relative(root, join(inside, "case.test.ts"));
	const lookalike = `${selected}.test.ts`;
	writeFileSync(join(root, selected), "throw new Error('file-only listing must not evaluate test modules');\n");
	writeFileSync(join(root, lookalike), "throw new Error('must not schedule substring lookalike');\n");
	const plan = await resolveHarnessRunPlan(["--file", selected]);
	expect(listFiles([selected])).toEqual([selected, lookalike]);
	const env = { ...process.env, SUMOCODE_INTEGRATION_SELECTED_FILE: plan.selectedFile };
	expect(listFiles(plan.integrationArgs.slice(1), env)).toEqual([selected]);
	// Multiple filters must retain Vitest's union, including the substring collision.
	expect(listFiles([selected, "src/footer.test.ts"], env)).toEqual(listFiles([selected, "src/footer.test.ts"]));
});

it.each([
	["default units / unit marker", [], "src/footer.test.ts"],
	["default units / integration marker", [], "test/integration/rpc-contract.test.ts"],
	["directory", ["test/integration/"], "test/integration/rpc-contract.test.ts"],
	["full", ["test/integration/", "--exclude", "test/integration/verification-harness.test.ts"], "test/integration/rpc-contract.test.ts"],
	["native prefix", ["test/integration/native-"], "test/integration/rpc-contract.test.ts"],
	["unrelated unit", ["src/footer.test.ts"], "test/integration/rpc-contract.test.ts"],
	["conflicting file", ["test/integration/verification-harness.test.ts"], "test/integration/rpc-contract.test.ts"],
	["mixed files", ["test/integration/rpc-contract.test.ts", "src/footer.test.ts"], "test/integration/rpc-contract.test.ts"],
	["multiple integration files", ["test/integration/rpc-contract.test.ts", "test/integration/verification-harness.test.ts"], "test/integration/rpc-contract.test.ts"],
	["duplicate selection", ["test/integration/rpc-contract.test.ts", "test/integration/rpc-contract.test.ts"], "test/integration/rpc-contract.test.ts"],
	["option value, not a filter", ["--exclude", "test/integration/rpc-contract.test.ts"], "test/integration/rpc-contract.test.ts"],
	["test-name value, not a filter", ["-t", "test/integration/rpc-contract.test.ts"], "test/integration/rpc-contract.test.ts"],
	["unrelated substring", ["rpc-contract"], "test/integration/rpc-contract.test.ts"],
	["noncanonical absolute", [join(root, "test/integration/rpc-contract.test.ts")], join(root, "test/integration/rpc-contract.test.ts")],
	["noncanonical double slash", ["test/integration//rpc-contract.test.ts"], "test/integration//rpc-contract.test.ts"],
	["noncanonical dot prefix", ["./test/integration/rpc-contract.test.ts"], "./test/integration/rpc-contract.test.ts"],
	["noncanonical traversal", ["test/integration/../integration/rpc-contract.test.ts"], "test/integration/../integration/rpc-contract.test.ts"],
	["noncanonical glob", ["test/integration/*.test.ts"], "test/integration/*.test.ts"],
	["unit selection", ["src/footer.test.ts"], "src/footer.test.ts"],
	["noncanonical marker", ["test/integration/rpc-contract.test.ts"], "./test/integration/rpc-contract.test.ts"],
])("keeps public file-only discovery unchanged with an inherited marker: %s", (_name, args, marker) => {
	const expected = listFiles(args);
	if (args.length === 0) {
		expect(expected).toContain("src/footer.test.ts");
		expect(expected.some((file) => file.startsWith("test/integration/"))).toBe(false);
	}
	expect(listFiles(args, { ...process.env, SUMOCODE_INTEGRATION_SELECTED_FILE: marker })).toEqual(expected);
});
