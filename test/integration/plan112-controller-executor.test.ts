import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../../src/background-tasks/process-tree.js";
import { SubagentRegistry, type RegistryProcess, type SubagentRecord } from "../../src/subagents/registry.js";
import { RetainedResults } from "../../src/subagents/retained-results.js";
import { controlAuthority, type RetainedSubagent } from "../../src/subagents/retained-adoption.js";
import type { PiExecLike } from "../../src/terminal-host/types.js";
import { install } from "./fixtures/plan112-source-controller.js";
import { visibleRecoveryExecutor } from "./fixtures/plan112-visible-recovery.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it.each([
	{ visible: true, refused: false, local: false },
	{ visible: false, refused: false, local: false },
	{ visible: true, refused: true, local: false },
	{ visible: true, refused: false, local: true },
	{ visible: false, refused: false, local: true },
])("fixture recovery uses the Herdr inspector only when visible: %j", async ({ visible, refused, local }) => {
	vi.useFakeTimers(); vi.setSystemTime(1000);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "controller-executor-")));
	const taskDir = join(root, "task"); mkdirSync(taskDir, { mode: 0o700 });
	const tree = (pid: number): RegistryProcess => ({ identity: { pid, processGroupId: pid, processStartTime: "command" },
		verification: { members: [{ pid, processStartTime: "birth" }] } });
	const operations: ProcessTreeOperations = {
		captureStartTime: () => "command", identityMatches: () => "same", verificationMatches: () => "same",
		isTreeEmpty: () => false, signalTree: vi.fn(), waitForTreeEmpty: vi.fn(),
		census: () => [{ pid: 42, processGroupId: 42, processStartTime: "birth" }],
	};
	let oldAlive = true;
	const registry = new SubagentRegistry(join(root, "registry"), "origin", {
		writerIdentity: { token: "writer", pid: 99, processStartTime: "command" },
		inspectWriter: (owner) => owner.token === "old" && !oldAlive ? "dead" : "alive",
	});
	const initial: SubagentRecord = { schemaVersion: 2, revision: 1, id: "sa-real", ownerSessionId: "origin", backend: visible ? "visible" : "headless",
		status: "starting", taskDir, child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
		createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0 };
	registry.create(initial);
	let record = registry.acquireWriter(initial.id, 1, 60_000);
	record = registry.transition(record.id, record.revision, record.writerLease!.generation, (current) => ({ ...current,
		status: "running", child: tree(42), supervisor: tree(local ? process.pid : 99), pane: visible ? { paneId: "w1:p2", agentName: "worker" } : null }));
	new RetainedResults(taskDir).append({ kind: "run-started" });
	const exec = vi.fn<PiExecLike["exec"]>(async (command, args) => {
		expect(command).toBe("herdr");
		expect(args).toEqual(["pane", "process-info", "--pane", "w1:p2"]);
		return { code: refused ? 1 : 0, stderr: "", killed: false, stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: {
			pane_id: "w1:p2", shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 43 }],
		} } }) };
	});
	const options = { visible, executor: { exec }, operations };
	const previous = local ? install("origin", undefined, options) : undefined;
	record = registry.acquireControl(record.id, record.revision, record.writerLease!.generation, 0,
		previous?.manager.controllerIdentity ?? { token: "old", pid: 77, processStartTime: "command" }, local ? 60_000 : 10);
	if (!local) { oldAlive = false; vi.setSystemTime(2000); }
	const runtime = install("successor", local ? undefined : registry, options);
	try {
		if (previous) {
			const supervisor: NonNullable<RetainedSubagent["supervisor"]> = {
				get record() { return registry.get(initial.id)!; }, completion: undefined,
				subscribe: () => () => {},
				controllerChild: () => ({ events: () => {}, interrupt: () => {} }),
				reserveControl: (authority, successor) => {
					const current = registry.get(initial.id)!;
					return registry.reserveControl(current.revision, authority, `${current.id}:${current.controlHead + 1}`, {
						...successor, writerGeneration: current.writerLease!.generation,
					});
				},
			};
			await previous.manager.trackRetained({ registry: registry.forController(previous.manager.controllerIdentity), supervisor,
				authority: controlAuthority(record), snapshot: { id: initial.id, title: "worker", prompt: "task", cwd: taskDir,
					baseRef: "HEAD", status: "running", createdAt: 1000, visible, usage: { turns: 0 }, transcript: [], liveText: "",
					liveTools: [], finalText: "" } });
			await previous.fire("session_shutdown", "new");
		}
		await runtime.fire("session_start", local ? "new" : "restart");
		expect(runtime.manager.get(initial.id)).toMatchObject({ recovery: refused ? "ambiguous" : "adopted", visible });
		if (refused) expect(runtime.manager.get(initial.id)?.recoveryReason).toEqual({
			code: "visible-pane-inspection", expected: "verified", observed: "refused",
		});
		if (visible) expect(exec).toHaveBeenCalled();
		else expect(exec).not.toHaveBeenCalled();
		expect(registry.get(initial.id)?.child).toEqual(record.child);
		expect(registry.get(initial.id)?.supervisor).toEqual(record.supervisor);
		expect(registry.get(initial.id)?.pane).toEqual(record.pane);
		expect(operations.signalTree).not.toHaveBeenCalled();
	} finally { previous?.manager.detachForReplacement(); runtime.manager.detachForReplacement(); }
});

it("the shared visible executor rejects commands outside the explicit Herdr capability", async () => {
	vi.stubEnv("PLAN112_HERDR_BIN", "/must-not-run");
	await expect(visibleRecoveryExecutor.exec("bash", [])).rejects.toThrow("unexpected visible recovery command");
});

it.each([undefined, "herdr"])("the shared visible executor refuses an unpinned binary: %s", async (binary) => {
	vi.stubEnv("PLAN112_HERDR_BIN", binary);
	await expect(visibleRecoveryExecutor.exec("herdr", ["pane", "list"])).rejects.toThrow("explicit absolute Herdr executable required");
});
