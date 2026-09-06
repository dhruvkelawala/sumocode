import { chmodSync, mkdtempSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRetainedBootstrap } from "./retained-bootstrap.js";
import type { SubagentRecord } from "./registry.js";
import install from "./retained-system-prompt.js";
import { assertNoFactoryReceipt, createBootstrapBinding, RETAINED_BOOTSTRAP_ENV, receiptPath, hasFactoryReceipt, publishFactoryReceipt } from "./retained-bootstrap-receipt.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- OS process observation only; never execute ps in this unit suite.
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "child-birth"), execFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumo-source-hook-")));
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const pi = join(root, "pi");
	writeFileSync(pi, "#!/usr/bin/env node\n", { mode: 0o755 });
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-hook", ownerSessionId: "session", taskDir,
		backend: "headless", status: "starting", child: null, supervisor: null, pane: null, worktree: null,
		sessionFilePath: null, modelLabel: "provider/model", roleId: null, createdAt: 1, updatedAt: 1,
		settledAt: null, completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const descriptor = prepareRetainedBootstrap(record, {
		cwd: root, baseRef: "HEAD", model: { provider: "provider", modelId: "model", label: "provider/model" },
		thinking: "low", builtInTools: ["read"], role: null, pi, adapterEntry: null, modelBootstrapEntry: null, visible: null,
	}, { prompt: "private task λ\nnext", systemPrompt: "private role instruction" });
	const binding = createBootstrapBinding(descriptor);
	vi.stubEnv(RETAINED_BOOTSTRAP_ENV, JSON.stringify(binding));
	return { descriptor, binding };
}

function fatalSpy() {
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("stubbed process.exit"); });
	return { stderr, exit };
}

describe("retained source system prompt factory", () => {
	it.each(["registration", "bootstrap", "environment"])("uses real process.exit(1), not throw-only, on %s failure without a receipt", (cut) => {
		const { binding } = fixture();
		const { stderr, exit } = fatalSpy();
		if (cut === "bootstrap") writeFileSync(join(binding.taskDir, "bootstrap-system-prompt.json"), '"tampered private role"');
		if (cut === "environment") vi.stubEnv(RETAINED_BOOTSTRAP_ENV, "malformed secret");
		const on = vi.fn(() => { throw new Error("registration secret"); });
		// SAFETY: only registration is available; failure must use the OS exit boundary.
		expect(() => install({ on } as never)).toThrow("stubbed process.exit");
		expect(exit).toHaveBeenCalledWith(1);
		expect(stderr).toHaveBeenCalledWith("[sumocode] retained bootstrap refused\n");
		expect(existsSync(receiptPath(binding))).toBe(false);
		if (cut !== "registration") expect(on).not.toHaveBeenCalled();
	});

	it.each(["text", "descriptor", "mode"])("revalidates after receipt and fatally exits on %s tamper before returning a system prompt", (cut) => {
		const { binding } = fixture();
		let handler!: (event: BeforeAgentStartEvent) => { systemPrompt: string };
		const on = vi.fn((_name: string, callback: typeof handler) => { handler = callback; });
		// SAFETY: the fake API captures the public before_agent_start handler.
		install({ on } as never);
		expect(existsSync(receiptPath(binding))).toBe(true);
		if (cut === "text") writeFileSync(join(binding.taskDir, "bootstrap-system-prompt.json"), '"tampered private role"');
		if (cut === "descriptor") writeFileSync(join(binding.taskDir, "bootstrap.json"), "{}");
		if (cut === "mode") chmodSync(join(binding.taskDir, "bootstrap-system-prompt.json"), 0o644);
		const { stderr, exit } = fatalSpy();
		// SAFETY: the hook consumes only systemPrompt from the Pi event.
		const event = { systemPrompt: "base" } as BeforeAgentStartEvent;
		try { handler(event); } catch { /* Pi catches hook exceptions. */ }
		expect(exit).toHaveBeenCalledExactlyOnceWith(1);
		expect(stderr).toHaveBeenCalledExactlyOnceWith("[sumocode] retained bootstrap refused\n");
	});

	it.each(["pid", "birth", "id", "owner", "path", "nonce", "hash", "stale", "extra", "malformed", "symlink", "mode"])("rejects %s receipt evidence and preserves it", (cut) => {
		const { binding } = fixture();
		const child = { pid: process.pid, processStartTime: "child-birth" };
		publishFactoryReceipt(binding, child);
		const path = receiptPath(binding);
		const receipt = { schemaVersion: 1, binding, child };
		if (cut === "pid") receipt.child = { ...child, pid: child.pid + 1 };
		if (cut === "birth") receipt.child = { ...child, processStartTime: "other-birth" };
		if (cut === "id") receipt.binding = { ...binding, id: "sa-other" };
		if (cut === "owner") receipt.binding = { ...binding, ownerSessionId: "other-session" };
		if (cut === "path") receipt.binding = { ...binding, taskDir: join(binding.taskDir, "stale") };
		if (cut === "nonce") receipt.binding = { ...binding, nonce: "00000000-0000-4000-8000-000000000000" };
		if (cut === "hash") receipt.binding = { ...binding, sha256: "0".repeat(64) };
		if (cut === "stale") receipt.binding = { ...binding, launchNonce: "00000000-0000-4000-8000-000000000000" };
		writeFileSync(path, JSON.stringify(cut === "extra" ? { ...receipt, extra: "secret" } : receipt));
		if (cut === "malformed") writeFileSync(path, "{secret");
		if (cut === "mode") chmodSync(path, 0o644);
		if (cut === "symlink") { renameSync(path, `${path}.preserved`); symlinkSync(`${path}.preserved`, path); }
		expect(() => hasFactoryReceipt(binding, child)).toThrow("unsafe retained factory receipt");
		expect(() => assertNoFactoryReceipt(binding)).toThrow("unsafe retained factory receipt");
		expect(existsSync(path)).toBe(true);
	});

	it("validates, registers, then receipts before any session event; appends privately each turn", async () => {
		const { binding } = fixture();
		let handler!: (event: BeforeAgentStartEvent) => { systemPrompt: string };
		const on = vi.fn((name, callback) => {
			expect(name).toBe("before_agent_start");
			expect(existsSync(receiptPath(binding))).toBe(false);
			handler = callback;
		});
		// SAFETY: only ExtensionAPI.on is used by this factory.
		install({ on } as never);
		expect(hasFactoryReceipt(binding, { pid: process.pid, processStartTime: "child-birth" })).toBe(true);
		// SAFETY: the hook consumes only systemPrompt from the Pi event.
		const event = { systemPrompt: "base" } as BeforeAgentStartEvent;
		expect(await handler(event)).toEqual({ systemPrompt: "base\n\nprivate role instruction" });
		expect(await handler(event)).toEqual({ systemPrompt: "base\n\nprivate role instruction" });
	});
});
