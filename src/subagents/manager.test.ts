import { describe, expect, it, vi } from "vitest";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import type { SubagentEvent } from "./domain.js";

const makeTask = (title: string): SpawnSubagentTask => ({ title, prompt: `prompt ${title}`, cwd: "/tmp" });

const deferredBackend = () => {
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const interrupts = new Map<string, ReturnType<typeof vi.fn>>();
	const manager = new SubagentManager((task) => {
		const interrupt = vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } }));
		interrupts.set(task.id, interrupt);
		return {
			events: (emit) => emitters.set(task.id, emit),
			interrupt,
		};
	});
	return { manager, emitters, interrupts };
};

describe("SubagentManager", () => {
	it("enforces capacity synchronously", () => {
		const { manager } = deferredBackend();
		for (let index = 0; index < 4; index += 1) expect(manager.spawn(makeTask(`${index}`))).toMatchObject({ id: `sa-${index + 1}` });
		const over = manager.spawn(makeTask("over"));
		expect(over).toMatchObject({ status: "at_capacity", capacity: 4, runningCount: 4 });
		expect(manager.list()).toHaveLength(4);
	});

	it("folds events into immutable snapshots", () => {
		const { manager, emitters } = deferredBackend();
		const spawned = manager.spawn(makeTask("fold"));
		expect(spawned).toMatchObject({ id: "sa-1" });
		emitters.get("sa-1")?.({ kind: "assistant-delta", delta: "hi" });
		expect(manager.get("sa-1")?.liveText).toBe("hi");
		emitters.get("sa-1")?.({ kind: "message-end", role: "assistant", text: "hi done" });
		expect(manager.get("sa-1")?.liveText).toBe("");
		expect(manager.get("sa-1")?.finalText).toBe("hi done");
		expect(manager.get("sa-1")?.usage.turns).toBe(1);
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "hi done" } });
		expect(manager.get("sa-1")?.status).toBe("done");
	});

	it("waitFor resolves settled snapshots and marks them consumed", async () => {
		const { manager, emitters } = deferredBackend();
		manager.spawn(makeTask("wait"));
		const pending: string[][] = [];
		const wait = manager.waitFor(["sa-1"], undefined, (snapshots) => pending.push(snapshots.map((snapshot) => snapshot.id)));
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await expect(wait).resolves.toMatchObject([{ id: "sa-1", status: "done" }]);
		expect(pending).toEqual([["sa-1"]]);
		expect(manager.consumedIds.has("sa-1")).toBe(true);
	});

	it("waitFor rejects unknown ids with known id list", async () => {
		const { manager } = deferredBackend();
		manager.spawn(makeTask("known"));
		await expect(manager.waitFor(["sa-2"])).rejects.toThrow("Known ids: sa-1");
	});

	it("cancels running children and reports already-settled ids", async () => {
		const { manager, emitters, interrupts } = deferredBackend();
		manager.spawn(makeTask("run"));
		manager.spawn(makeTask("done"));
		emitters.get("sa-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await expect(manager.cancel(["sa-1", "sa-2"])).resolves.toEqual(["Cancelled sa-1", "sa-2 was already done"]);
		expect(interrupts.get("sa-1")).toHaveBeenCalled();
		expect(manager.consumedIds.has("sa-1")).toBe(true);
	});

	it("prunes oldest settled snapshots above max tracked", () => {
		const { manager, emitters } = deferredBackend();
		for (let index = 0; index < 65; index += 1) {
			const result = manager.spawn(makeTask(`${index}`));
			expect(result).toHaveProperty("id");
			emitters.get(`sa-${index + 1}`)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		}
		expect(manager.list()).toHaveLength(64);
		expect(manager.get("sa-1")).toBeUndefined();
		expect(manager.get("sa-65")).toBeDefined();
	});

	it("keeps terminal state sticky when a late real settle arrives after cancel timeout", async () => {
		let emitFn: ((event: import("./domain.js").SubagentEvent) => void) | undefined;
		const manager = new SubagentManager(() => ({
			events: (emit) => { emitFn = emit; },
			interrupt: vi.fn(),
		}));
		const spawned = manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		const id = (spawned as { id: string }).id;
		emitFn?.({ kind: "run-settled", outcome: { kind: "interrupted" } });
		expect(manager.get(id)?.status).toBe("error");
		const settledAt = manager.get(id)?.settledAt;
		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "late success" } });
		expect(manager.get(id)?.status).toBe("error");
		expect(manager.get(id)?.settledAt).toBe(settledAt);
		expect(manager.get(id)?.finalText).not.toBe("late success");
	});
});
