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
	const list = (args, selectedFile) => {
		const env = { ...process.env };
		delete env.SUMOCODE_INTEGRATION_SELECTED_FILE;
		if (selectedFile) env.SUMOCODE_INTEGRATION_SELECTED_FILE = selectedFile;
		const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "list", ...args, "--filesOnly", "--json"], {
			cwd: root, env, encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(result.stdout).map((entry) => relative(root, entry.file));
	};
	expect(list([selected])).toEqual(expect.arrayContaining([selected, lookalike]));
	expect(list(plan.integrationArgs.slice(1), plan.selectedFile)).toEqual([selected]);
});
