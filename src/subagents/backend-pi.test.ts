import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiChildSpawner, resolveClaudeOauthAdapterEntry } from "./backend-pi.js";
import type { SubagentEvent } from "./domain.js";

class FakeProcess extends EventEmitter {
	public readonly stdin = { end: vi.fn() };
	public readonly stdout = new EventEmitter();
	public readonly stderr = new EventEmitter();
	public pid = 4242;
	public killed = false;
	public kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
}

const collect = (events: ((emit: (event: SubagentEvent) => void) => void)): SubagentEvent[] => {
	const collected: SubagentEvent[] = [];
	events((event) => collected.push(event));
	return collected;
};

describe("resolveClaudeOauthAdapterEntry", () => {
	it("returns undefined when the package is not installed anywhere", () => {
		expect(resolveClaudeOauthAdapterEntry({ PI_CODING_AGENT_DIR: "/nonexistent-agent-dir" })).toBeUndefined();
	});

	it("resolves the Pi-managed checkout for the installed multi-account Git adapter", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "sumo-oauth-agent-"));
		const checkout = join(agentDir, "git", "github.com", "dhruvkelawala", "pi-claude-oauth-adapter");
		mkdirSync(join(checkout, "extensions"), { recursive: true });
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/index.ts"] } }));
		writeFileSync(join(checkout, "extensions", "index.ts"), "// adapter");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account"] }),
		);

		expect(resolveClaudeOauthAdapterEntry({ PI_CODING_AGENT_DIR: agentDir }))
			.toBe(join(checkout, "extensions", "index.ts"));
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("resolves a local-checkout path source from GLOBAL settings packages", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "sumo-oauth-agent-"));
		// The path source must mention the package name to be considered.
		const checkout = join(tmpdir(), `pi-claude-oauth-adapter-${Date.now()}`);
		mkdirSync(join(checkout, "extensions"), { recursive: true });
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/index.ts"] } }));
		writeFileSync(join(checkout, "extensions", "index.ts"), "// adapter");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [checkout] }));
		expect(resolveClaudeOauthAdapterEntry({ PI_CODING_AGENT_DIR: agentDir }))
			.toBe(join(checkout, "extensions", "index.ts"));
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(checkout, { recursive: true, force: true });
	});

	it("resolves relative settings path sources against the settings dir, not process cwd", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "sumo-oauth-agent-"));
		const pkgDir = join(agentDir, "checkouts", "pi-claude-oauth-adapter");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/index.ts"] } }));
		writeFileSync(join(pkgDir, "extensions", "index.ts"), "// adapter");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["./checkouts/pi-claude-oauth-adapter"] }));
		expect(resolveClaudeOauthAdapterEntry({ PI_CODING_AGENT_DIR: agentDir }))
			.toBe(join(pkgDir, "extensions", "index.ts"));
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("honors the SUMOCODE_CLAUDE_OAUTH_ADAPTER env override pointing at an entry file", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumo-oauth-override-"));
		const entry = join(dir, "index.ts");
		writeFileSync(entry, "// adapter");
		expect(resolveClaudeOauthAdapterEntry({ SUMOCODE_CLAUDE_OAUTH_ADAPTER: entry })).toBe(entry);
		// Any file works — the resolver probes the filesystem, not extensions.
		const mjs = join(dir, "index.mjs");
		writeFileSync(mjs, "// adapter");
		expect(resolveClaudeOauthAdapterEntry({ SUMOCODE_CLAUDE_OAUTH_ADAPTER: mjs })).toBe(mjs);
		expect(resolveClaudeOauthAdapterEntry({ SUMOCODE_CLAUDE_OAUTH_ADAPTER: join(dir, "missing.ts") })).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("spawnPiChild", () => {
	it("translates pi json-line events", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(spawn as never)({
			prompt: "do work",
			cwd: "/tmp/project",
			inherited: { thinking: "low" },
		});
		// SAFETY: the pane/pi backends always expose the callback events form here.
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);

		proc.stdout.emit("data", `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo hi" } })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "hi" }] } })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: "done" })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "hello", usage: { totalTokens: 12, cost: { total: 0.01 } } } })}\n`);
		proc.emit("close", 0);

		expect(spawn).toHaveBeenCalledWith("pi", expect.arrayContaining(["--mode", "json", "-p", "do work"]), expect.objectContaining({ cwd: "/tmp/project" }));
		expect(events).toEqual([
			{ kind: "run-started" },
			{ kind: "assistant-delta", delta: "hel" },
			expect.objectContaining({ kind: "tool-start", toolId: "t1", name: "bash" }),
			{ kind: "tool-update", toolId: "t1", outputPreview: "hi" },
			{ kind: "tool-end", toolId: "t1", name: "bash", isError: false, outputPreview: "done" },
			{ kind: "message-end", role: "assistant", text: "hello" },
			{ kind: "usage", tokens: 12, contextWindow: undefined, costUsd: 0.01 },
			{ kind: "run-settled", outcome: { kind: "completed", finalText: "hello" } },
		]);
	});

	it("redacts nested tool argument secrets before producing a bounded preview", () => {
		const proc = new FakeProcess();
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		proc.stdout.emit("data", `${JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "secret-tool",
			toolName: "custom",
			args: {
				query: "visible",
				nested: { token: "secret-token", credentials: { password: "secret-password" } },
			},
		})}\n`);

		const event = events.find((candidate) => candidate.kind === "tool-start");
		expect(event).toMatchObject({ kind: "tool-start", argsPreview: expect.stringContaining("visible") });
		if (event?.kind !== "tool-start") throw new Error("missing tool-start event");
		expect(event.argsPreview).toContain("[REDACTED]");
		expect(event.argsPreview).not.toContain("secret-token");
		expect(event.argsPreview).not.toContain("secret-password");
		expect(event.argsPreview?.length).toBeLessThanOrEqual(160);
	});

	it("reports abort as interrupted", () => {
		const proc = new FakeProcess();
		const controller = new AbortController();
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		controller.abort();
		killSpy.mockRestore();
		proc.emit("close", null);
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "interrupted", partialText: undefined } });
	});

	it("reports nonzero exit with stderr", () => {
		const proc = new FakeProcess();
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		proc.stderr.emit("data", "boom");
		proc.emit("close", 2);
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "failed", errorText: "boom", partialText: undefined } });
	});

	it("appends role system instructions after task args and before the prompt", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		// SAFETY: the spawn double only needs to return a FakeProcess; the spawner reads no other spawn surface.
		const child = createPiChildSpawner(spawn as never, () => undefined)({
			prompt: "do work",
			cwd: "/tmp",
			inherited: {},
			appendSystemPrompt: "review carefully",
		});
		// SAFETY: FakeProcess.events exposes the (emit) => void collector shape collect expects.
		collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		// SAFETY: mock.calls[0][1] is the argv string array recorded by the vi.fn spawn double.
		const args = (spawn.mock.calls[0] as unknown[])[1] as string[];
		const appendIndex = args.indexOf("--append-system-prompt");
		expect(appendIndex).toBeGreaterThan(args.indexOf("--tools"));
		expect(args[appendIndex + 1]).toBe("review carefully");
		expect(args.at(-1)).toBe("do work");
	});

	it("omits role system instructions when none are configured", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		// SAFETY: the spawn double only needs to return a FakeProcess; the spawner reads no other spawn surface.
		const child = createPiChildSpawner(spawn as never, () => undefined)({ prompt: "x", cwd: "/tmp", inherited: {} });
		// SAFETY: FakeProcess.events exposes the (emit) => void collector shape collect expects.
		collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		// SAFETY: mock.calls[0][1] is the argv string array recorded by the vi.fn spawn double.
		const args = (spawn.mock.calls[0] as unknown[])[1] as string[];
		expect(args).not.toContain("--append-system-prompt");
	});

	it("injects the claude-oauth adapter via -e when the resolver finds it", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(spawn as never, () => "/fake/adapter/extensions/index.ts")({ prompt: "x", cwd: "/tmp", inherited: {} });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		// SAFETY: the typed spawn double records (command, args) pairs.
		const args = (spawn.mock.calls[0] as unknown[])[1] as string[];
		const eIndex = args.indexOf("-e");
		expect(eIndex).toBeGreaterThan(-1);
		expect(args[eIndex + 1]).toBe("/fake/adapter/extensions/index.ts");
		// The prompt must remain the trailing positional after the adapter args.
		expect(args[args.length - 1]).toBe("x");
	});

	it("omits the -e flag when no adapter is installed", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(spawn as never, () => undefined)({ prompt: "x", cwd: "/tmp", inherited: {} });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		// SAFETY: the typed spawn double records (command, args) pairs.
		const args = (spawn.mock.calls[0] as unknown[])[1] as string[];
		expect(args).not.toContain("-e");
	});

	it("spawns the child detached and signals the whole process group on interrupt", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const proc = new FakeProcess();
			const spawn = vi.fn(() => proc);
			const controller = new AbortController();
			// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
			const child = createPiChildSpawner(spawn as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			// SAFETY: the pane/pi backends always expose the callback events form here.
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			expect(spawn).toHaveBeenCalledWith("pi", expect.any(Array), expect.objectContaining({ detached: true }));
			controller.abort();
			// Group signal: negative pid targets the whole tree, not just pi.
			expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(proc.kill).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});

	it("falls back to single-pid kill when the group signal fails", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });
		try {
			const proc = new FakeProcess();
			const controller = new AbortController();
			// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
			const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			// SAFETY: the pane/pi backends always expose the callback events form here.
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			controller.abort();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			killSpy.mockRestore();
		}
	});

	it("escalates to SIGKILL when the child ignores SIGTERM (no close event)", () => {
		vi.useFakeTimers();
		try {
			const proc = new FakeProcess();
			const controller = new AbortController();
			// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
			const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			// SAFETY: the pane/pi backends always expose the callback events form here.
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
			try {
				controller.abort();
				expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
				// The signal was SENT but the process never exited — the fallback
				// must still fire because it tracks close, not killed.
				vi.advanceTimersByTime(5001);
				expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
			} finally {
				killSpy.mockRestore();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not SIGKILL a child that exited after SIGTERM", () => {
		vi.useFakeTimers();
		try {
			const proc = new FakeProcess();
			const controller = new AbortController();
			// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
			const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			// SAFETY: the pane/pi backends always expose the callback events form here.
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
			try {
				controller.abort();
				proc.emit("close", null);
				vi.advanceTimersByTime(5001);
				const kills = killSpy.mock.calls.filter(([pid]) => pid === -4242);
				expect(kills).toEqual([[-4242, "SIGTERM"]]);
			} finally {
				killSpy.mockRestore();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles as failed without spawning when the model override is invalid", () => {
		const spawn = vi.fn();
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(spawn as never)({ prompt: "x", cwd: "/tmp", model: "gpt5-no-slash", inherited: {} });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		expect(spawn).not.toHaveBeenCalled();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "run-settled", outcome: { kind: "failed" } });
		expect(() => child.interrupt()).not.toThrow();
	});

	it("treats an externally signalled child (null code) as failed, not completed", () => {
		const proc = new FakeProcess();
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		// External SIGTERM (operator kill / host cleanup): Node reports
		// code=null with the signal — must never fold as completed.
		proc.emit("close", null, "SIGTERM");
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "failed", errorText: "pi killed by SIGTERM", partialText: undefined } });
	});

	it("treats exit 0 with empty final text as completed, matching native-task semantics", () => {
		const proc = new FakeProcess();
		// SAFETY: the FakeProcess double satisfies the SpawnLike contract used on this path.
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		// SAFETY: the pane/pi backends always expose the callback events form here.
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		proc.emit("close", 0);
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "completed", finalText: "" } });
	});
});
