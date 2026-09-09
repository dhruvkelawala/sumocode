import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { controlAuthority, reserveRemoteControl, serveRetainedControl } from "./retained-control.js";

afterEach(() => { vi.useRealTimers(); });

it("transfers remote control through the writer without moving persistence ownership", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-remote-control-")));
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const writer = { token: "writer", pid: 101, processStartTime: "writer-birth" };
	const origin = { token: "origin", pid: 102, processStartTime: "origin-birth" };
	const successor = { token: "successor", pid: 103, processStartTime: "successor-birth" };
	const registry = new SubagentRegistry(join(root, "registry"), "session-a", { writerIdentity: writer, inspectWriter: () => "alive" });
	const initial: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-remote", ownerSessionId: "session-a", backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
		createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	registry.create(initial);
	const held = registry.acquireWriter(initial.id, 1, 60_000);
	const granted = registry.acquireControl(initial.id, held.revision, 1, 0, origin, 60_000);
	const authority = controlAuthority(granted);
	const child = vi.fn(() => ({ events: () => undefined, interrupt: vi.fn() }));
	const stop = serveRetainedControl(registry, initial.id, child, (current, next) => {
		const fresh = registry.get(initial.id)!;
		return registry.reserveControl(fresh.revision, current, `${current.id}:${current.head + 1}`, { ...next, writerGeneration: 1 });
	});
	try {
		const transfer = reserveRemoteControl(registry.forController(origin), authority, { sessionId: "session-b", owner: successor });
		await vi.advanceTimersByTimeAsync(500);
		const reserved = await transfer;
		expect(reserved.writerLease).toEqual(held.writerLease);
		expect(reserved.controlReservation).toEqual({ sessionId: "session-b", owner: successor });
		expect(registry.inspectControl(authority)).toBe(false);
		const next = registry.forController(successor).acquireControl(initial.id, reserved.revision, 1, reserved.controlHead, successor, 60_000, "session-b");
		expect(registry.inspectControl(controlAuthority(next))).toBe(true);
		expect(child).not.toHaveBeenCalled();
	} finally { stop(); }
});
