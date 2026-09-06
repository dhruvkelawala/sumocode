import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preflightRecovery, recoveryEnvironment } from "../../scripts/plan112-recovery-preflight.mjs";
import { runRealRecovery } from "./fixtures/plan112-real-recovery.js";

afterEach(() => vi.unstubAllEnvs());

function privateRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "plan112-preflight-")));
	chmodSync(root, 0o700);
	return root;
}

it("generates a fresh provider bound only to the caller's private namespace", async () => {
	vi.stubEnv("NODE_PATH", undefined);
	vi.stubEnv("NODE_OPTIONS", undefined);
	const root = privateRoot();
	const prepared = await preflightRecovery(root);
	expect(prepared.provider).toBe(join(root, "provider.mjs"));
	expect(readFileSync(prepared.provider, "utf8")).toContain(JSON.stringify(root));
	expect(readFileSync(prepared.provider, "utf8")).not.toContain("sumo112-real-di-kew08qwp");
	expect(existsSync(join(root, "provider-called.json"))).toBe(false);
	expect(prepared.node).toBe(realpathSync(process.execPath));
	expect(prepared.pi).toBe(realpathSync("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
	await expect(preflightRecovery(root)).rejects.toThrow();
});

it("rejects a public root before generating provider state", async () => {
	const root = privateRoot();
	chmodSync(root, 0o755);
	await expect(preflightRecovery(root)).rejects.toThrow("root must be owned 0700");
	expect(existsSync(join(root, "provider.mjs"))).toBe(false);
});

it("builds an explicit environment without credentials or preloads", () => {
	vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-only");
	vi.stubEnv("NODE_OPTIONS", "--synthetic-test-only");
	const env = recoveryEnvironment(privateRoot());
	expect(Object.keys(env).sort()).toEqual(["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR", "PATH", "CI", "NO_COLOR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "NODE_COMPILE_CACHE", "JITI_FS_CACHE"].sort());
	expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	expect(env.NODE_OPTIONS).toBeUndefined();
});

it("fails visible capability explicitly without Herdr rather than skipping", async () => {
	vi.stubEnv("HERDR_ENV", undefined);
	await expect(runRealRecovery("visible", "same-process factory replacement")).rejects.toThrow("capability: herdr unavailable");
});

it("refuses an unsupervised headless run before creating processes", async () => {
	vi.stubEnv("PLAN112_RECOVERY_ROOT", undefined);
	await expect(runRealRecovery("headless", "same-process factory replacement")).rejects.toThrow("supervised wrapper");
});
