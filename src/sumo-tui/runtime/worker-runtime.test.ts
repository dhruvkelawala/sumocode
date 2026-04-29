import { describe, expect, it } from "vitest";
import { CancellableWorkerRuntime } from "./worker-runtime.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("CancellableWorkerRuntime", () => {
	it("runs named jobs to completion", async () => {
		const runtime = new CancellableWorkerRuntime();
		const handle = runtime.start({
			name: "session-summary",
			run: ({ name, signal }) => ({ name, aborted: signal.aborted }),
		});

		await expect(handle.result).resolves.toEqual({
			status: "completed",
			value: { name: "session-summary", aborted: false },
		});
	});

	it("cancels and invalidates stale jobs in an exclusive group", async () => {
		const runtime = new CancellableWorkerRuntime();
		const firstGate = deferred<string>();
		const secondGate = deferred<string>();
		const first = runtime.start({
			name: "memory-refresh",
			exclusiveGroup: "sidebar-memory",
			run: async () => firstGate.promise,
		});
		const second = runtime.start({
			name: "memory-refresh",
			exclusiveGroup: "sidebar-memory",
			run: async () => secondGate.promise,
		});

		expect(first.signal.aborted).toBe(true);
		expect(first.isCurrent()).toBe(false);
		expect(second.isCurrent()).toBe(true);

		secondGate.resolve("new");
		await expect(second.result).resolves.toEqual({ status: "completed", value: "new" });

		firstGate.resolve("old");
		await expect(first.result).resolves.toEqual({
			status: "cancelled",
			id: first.id,
			name: "memory-refresh",
			exclusiveGroup: "sidebar-memory",
		});
	});

	it("keeps distinct exclusive groups independent", async () => {
		const runtime = new CancellableWorkerRuntime();
		const memory = runtime.start({ name: "memory-refresh", exclusiveGroup: "sidebar-memory", run: () => "memory" });
		const mcp = runtime.start({ name: "mcp-probe", exclusiveGroup: "sidebar-mcp", run: () => "mcp" });

		expect(memory.isCurrent()).toBe(true);
		expect(mcp.isCurrent()).toBe(true);
		await expect(memory.result).resolves.toEqual({ status: "completed", value: "memory" });
		await expect(mcp.result).resolves.toEqual({ status: "completed", value: "mcp" });
	});

	it("cancelGroup cancels the current exclusive worker", async () => {
		const runtime = new CancellableWorkerRuntime();
		const gate = deferred<string>();
		const handle = runtime.start({ name: "summary", exclusiveGroup: "session-summary", run: async () => gate.promise });

		expect(runtime.cancelGroup("session-summary")).toBe(true);
		expect(handle.signal.aborted).toBe(true);
		gate.resolve("done");

		await expect(handle.result).resolves.toEqual({
			status: "cancelled",
			id: handle.id,
			name: "summary",
			exclusiveGroup: "session-summary",
		});
		expect(runtime.cancelGroup("session-summary")).toBe(false);
	});
});
