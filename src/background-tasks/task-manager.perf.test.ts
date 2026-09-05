import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalTaskManager } from "./task-manager.js";
import { TerminalTaskStore } from "./task-store.js";
import type { TerminalTaskSnapshot } from "./task-types.js";

const roots: string[] = [];
const managers: TerminalTaskManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.detach();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The 10,000-record fixture isolates retained heap shape from filesystem timing.
// Real indexed-path/validation behavior remains covered by task-store.test.ts.
class HistoryStore extends TerminalTaskStore {
	public reads = 0;
	public scans = 0;
	public readonly records: TerminalTaskSnapshot[];
	public constructor(active: number, settled: number) {
		const rootDir = mkdtempSync(join(tmpdir(), "terminal-scale-"));
		roots.push(rootDir);
		super({ rootDir });
		this.records = Array.from({ length: active + settled }, (_, index) => ({
			schemaVersion: 4,
			revision: 1,
			id: `term-${index}`,
			ownerSessionId: "owner",
			command: "true",
			cwd: rootDir,
			title: `terminal ${index}`,
			createdAt: index + 1,
			updatedAt: 20_000,
			completionPolicy: "passive",
			logFile: join(rootDir, `term-${index}-${index + 1}`, "output.log"),
			...(index < active ? { status: "starting", deliveryState: "none" } as const : {
				status: "completed", deliveryState: "delivered", settledAt: index + 1,
				exitCode: 0, completionId: `completion-${index}`,
			} as const),
		}));
	}
	public override refreshIndex() {
		this.scans += 1;
		return { ok: true, complete: true, snapshots: this.records };
	}
	public override getIndexed(id: string) {
		this.reads += 1;
		return this.records[Number(id.slice(5))];
	}
	public override isIndexedOwner(id: string, owner: string) {
		return this.records[Number(id.slice(5))]?.ownerSessionId === owner;
	}
	public override listOwnedIndexed(owner: string) {
		return this.records.filter((record) => record.ownerSessionId === owner).toReversed();
	}
}

function fixture(active: number, settled = 0) {
	vi.useFakeTimers();
	const store = new HistoryStore(active, settled);
	const manager = new TerminalTaskManager({
		store, now: () => 20_000, scheduleIndexInitialization: (initialize) => initialize(),
	});
	managers.push(manager);
	return { manager, store };
}

it.each([0, 1, 100])("characterizes supervision work: %i active tasks use one supervision scheduler", async (active) => {
	const { manager, store } = fixture(active);
	await vi.advanceTimersByTimeAsync(0);
	store.reads = 0;
	expect(vi.getTimerCount()).toBe(active === 0 ? 0 : 1);
	await vi.advanceTimersByTimeAsync(250);
	expect(store.scans).toBe(1);
	expect(manager.getSnapshots()).toHaveLength(active);
	manager.detach();
	const reads = store.reads;
	await vi.advanceTimersByTimeAsync(1_000);
	expect(store.reads).toBe(reads);
	expect(vi.getTimerCount()).toBe(0);
});
