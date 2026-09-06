import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../../src/background-tasks/process-tree.js";
import type { PiExecLike } from "../../src/terminal-host/types.js";
import { runRealFault } from "./fixtures/plan112-real-faults.js";
import { cleanupOwnedTree } from "./fixtures/subagent-feasibility-cleanup.js";
import { visibleRecoveryLaunch } from "./fixtures/plan112-visible-recovery.js";

it.each([false, true])("refused cleanup waits for known emptiness=%s without another signal", async (empty) => {
	const signalTree = vi.fn();
	const waitForTreeEmpty = vi.fn(async () => empty);
	const tree = { identity: { pid: 42, processGroupId: 42, processStartTime: "command" }, verification: { members: [{ pid: 42, processStartTime: "birth" }] } };
	expect(await cleanupOwnedTree({ captureStartTime: () => undefined, identityMatches: () => "unknown", verificationMatches: () => "unknown",
		isTreeEmpty: () => false, signalTree, waitForTreeEmpty }, tree, () => {})).toBe(empty);
	expect(waitForTreeEmpty).toHaveBeenCalledWith(tree.identity, 2000, tree.verification);
	expect(signalTree).not.toHaveBeenCalled();
});

it.each([
	"ownership handoff: ambiguous-identity blocked with zero signal/delivery",
	"PID reuse denial: unknown anchor denies control and signals",
	"cleanup: unknown original anchor, unknown never means zero",
])("keeps the genuine OS-oracle capability classification: %s", async (name) => {
	const run = vi.fn();
	await expect(runRealFault(name, run)).rejects.toThrow("capability: cannot force kernel identity inspection failure");
	expect(run).not.toHaveBeenCalled();
});
it("dispatches different-original cleanup to real verified-absence observations", async () => {
	const run = vi.fn();
	await runRealFault("cleanup: different original anchor, unknown never means zero", run);
	expect(run).toHaveBeenCalledWith("headless", "parent crash-restart", "cleanup:different");
});

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

it.each(["same", "different", "revoked"])("real pane adapter holds both admissions; authority=%s", async (state) => {
	const changed = state === "different";
	let revoked = false;
	vi.useFakeTimers();
	const root = realpathSync(mkdtempSync(join(tmpdir(), "visible-admission-")));
	const task = join(root, "task"); mkdirSync(task, { mode: 0o700 });
	let command = "original shell";
	let nonce = "";
	let wrapper = false;
	const operations: ProcessTreeOperations = {
		captureStartTime: () => command,
		captureTreeVerification: () => ({ members: [{ pid: 42, processStartTime: changed && wrapper ? "other-birth" : "shell-birth" }] }),
		identityMatches: () => "same", verificationMatches: () => "same", isTreeEmpty: () => false,
		signalTree: vi.fn(), waitForTreeEmpty: vi.fn(),
	};
	const executor: PiExecLike = { exec: async (_binary, argv) => {
		if (argv[0] === "tab") return { code: 0, stderr: "", killed: false, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2" } } }) };
		if (argv[1] === "process-info") return { code: 0, stderr: "", killed: false, stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: {
			pane_id: "w1:p2", shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42 }],
		} } }) };
		if (argv[1] === "run") {
			expect(existsSync(join(root, "pane-shell-birth-admitted"))).toBe(true);
			expect(argv[3]).toContain("exec /usr/bin/env -i /bin/bash ");
			command = readFileSync(join(root, "pane-command.sh"), "utf8");
			expect(command).toContain(`HOME=${join(root, "home")}`);
			wrapper = true;
			writeFileSync(join(task, "launch.born"), `${nonce}\n42\n42\n${changed ? "other-birth" : "shell-birth"}\n`, { mode: 0o600 });
		}
		return { code: 0, stderr: "", killed: false, stdout: JSON.stringify({ result: { type: "ok" } }) };
	} };
	const adapter = visibleRecoveryLaunch(root, "/synthetic/pi", "/synthetic/provider", { executor, operations });
	const published = vi.fn(); const released = vi.fn(); const refused = vi.fn();
	const child = adapter.spawn({ id: "sa-visible", name: "worker", cwd: root, prompt: "task", retainedTaskDir: task,
		host: adapter.host, pi: adapter.pi, placement: { kind: "new-tab", label: "worker" }, launchGate: {
			beforeSpawn: (intent) => { nonce = intent.nonce; }, wrapperBorn: published, beforeRelease: released,
			beforeEffect: () => { if (revoked) throw new Error("writer lost"); }, interrupt: () => {}, onRefused: refused,
		} });
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SpawnedChild permits both callback and iterable event sources.
	if (typeof child.events !== "function") throw new Error("pane callback required");
	child.events(() => {});
	await vi.advanceTimersByTimeAsync(25);
	expect(existsSync(join(root, "pane-shell-birth.json"))).toBe(true);
	expect(wrapper).toBe(false);
	revoked = state === "revoked";
	writeFileSync(join(root, "pane-shell-birth-admitted"), "", { mode: 0o600 });
	await vi.advanceTimersByTimeAsync(75);
	if (revoked) {
		await expect(child.ready).rejects.toThrow();
		expect(wrapper).toBe(false);
		expect(published).not.toHaveBeenCalled();
		expect(existsSync(join(task, "launch.release"))).toBe(false);
		return;
	}
	expect(wrapper).toBe(true);
	expect(existsSync(join(task, "launch.release"))).toBe(false);
	if (changed) {
		await expect(child.ready).rejects.toThrow("pane shell birth changed");
		expect(published).not.toHaveBeenCalled();
		expect(released).not.toHaveBeenCalled();
		expect(refused).toHaveBeenCalled();
	} else {
		expect(published).toHaveBeenCalledOnce();
		expect(existsSync(join(root, "anchor-birth.json"))).toBe(true);
		writeFileSync(join(root, "anchor-birth-admitted"), "", { mode: 0o600 });
		await vi.advanceTimersByTimeAsync(50);
		await child.ready;
		expect(released).toHaveBeenCalledOnce();
		expect(readFileSync(join(task, "launch.release"), "utf8")).toBe(nonce);
	}
});
