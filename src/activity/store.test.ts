import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivitySnapshot } from "./domain.js";
import { ActivityFeedPublisher } from "./feed-publisher.js";
import { activityPaths, atomicWritePrivateJson } from "./persistence.js";
import { FileActivityStore } from "./store.js";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-activity-store-"));
	roots.push(path);
	return path;
}

function activity(id: string, status: ActivitySnapshot["status"] = "running"): ActivitySnapshot {
	return { id, kind: "terminal", title: id, status, createdAt: 1_000, updatedAt: 1_000 };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for ActivityStore update");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	vi.useRealTimers();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("FileActivityStore", () => {
	it("immediately replays one complete immutable snapshot", () => {
		const stateRoot = root();
		new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 }).publish([activity("term-1")]);
		const store = new FileActivityStore({ rootDir: stateRoot });
		store.bindSession("session-a");
		const seen: unknown[] = [];
		const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot));
		const first = seen[0] as ReturnType<typeof store.getSnapshot>;
		expect(seen).toHaveLength(1);
		expect(first.activities).toMatchObject([{ id: "term-1" }]);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.activities)).toBe(true);
		expect(Object.isFrozen(first.activities[0])).toBe(true);
		unsubscribe();
		store.dispose();
	});

	it("observes initially missing feed creation and atomic replacement", async () => {
		const stateRoot = root();
		const store = new FileActivityStore({ rootDir: stateRoot, debounceMs: 5, pollMs: 20 });
		store.bindSession("session-a");
		expect(store.getSnapshot().activities).toEqual([]);
		const publisher = new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		publisher.publish([activity("term-1")]);
		await waitFor(() => store.getSnapshot().activities[0]?.id === "term-1");
		const prior = store.getSnapshot();
		publisher.publish([activity("term-1", "succeeded")]);
		await waitFor(() => store.getSnapshot().activities[0]?.status === "succeeded");
		expect(prior.activities[0]?.status).toBe("running");
		store.dispose();
	});

	it("retains last known-good data for corrupt and unknown-schema replacements", async () => {
		const stateRoot = root();
		const diagnostics: string[] = [];
		const publisher = new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		publisher.publish([activity("term-1")]);
		const store = new FileActivityStore({
			rootDir: stateRoot,
			debounceMs: 5,
			pollMs: 20,
			onDiagnostic: (entry) => diagnostics.push(`${entry.kind}:${entry.message}`),
		});
		store.bindSession("session-a");
		const feedFile = activityPaths("session-a", stateRoot).feedFile;
		writeFileSync(feedFile, "{not-json", { mode: 0o600 });
		chmodSync(feedFile, 0o600);
		await waitFor(() => diagnostics.some((entry) => entry.startsWith("io:")));
		expect(store.getSnapshot().activities).toMatchObject([{ id: "term-1" }]);
		atomicWritePrivateJson(feedFile, { schemaVersion: 999, ownerSessionId: "session-a" });
		await waitFor(() => diagnostics.some((entry) => entry.startsWith("schema:")));
		expect(store.getSnapshot().activities).toMatchObject([{ id: "term-1" }]);
		store.dispose();
	});

	it("ignores stale watcher callbacks after an owner rebind", async () => {
		vi.useFakeTimers();
		const stateRoot = root();
		new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 }).publish([activity("a")]);
		new ActivityFeedPublisher("session-b", { rootDir: stateRoot, now: () => 2_000 }).publish([activity("b")]);
		const callbacks: Array<() => void> = [];
		const closed: boolean[] = [];
		const watchImpl = ((_path: string, callback: () => void) => {
			const index = callbacks.length;
			callbacks.push(callback);
			closed[index] = false;
			const watcher = {
				on: () => watcher,
				close: () => { closed[index] = true; },
			};
			return watcher;
		}) as unknown as typeof import("node:fs").watch;
		const store = new FileActivityStore({ rootDir: stateRoot, watch: watchImpl, debounceMs: 5, pollMs: 1_000 });
		store.bindSession("session-a");
		store.bindSession("session-b");
		expect(closed[0]).toBe(true);
		callbacks[0]?.();
		await vi.advanceTimersByTimeAsync(20);
		expect(store.getSnapshot()).toMatchObject({ ownerSessionId: "session-b", activities: [{ id: "b" }] });
		store.dispose();
	});

	it("suppresses revisions and listeners for semantic no-op feed revisions", async () => {
		const stateRoot = root();
		const publisher = new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		publisher.publish([activity("term-1")]);
		const store = new FileActivityStore({ rootDir: stateRoot, debounceMs: 5, pollMs: 20 });
		store.bindSession("session-a");
		const seen: number[] = [];
		store.subscribe((snapshot) => seen.push(snapshot.revision));
		const path = activityPaths("session-a", stateRoot).feedFile;
		const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		atomicWritePrivateJson(path, { ...document, revision: 99, updatedAt: 99 });
		await new Promise<void>((resolve) => setTimeout(resolve, 80));
		expect(seen).toHaveLength(1);
		store.dispose();
	});

	it("persists individual and global expansion in host-owned ui.json", () => {
		const stateRoot = root();
		new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 }).publish([activity("a"), activity("b")]);
		const first = new FileActivityStore({ rootDir: stateRoot, now: () => 3_000 });
		first.bindSession("session-a");
		first.setExpanded("a", false);
		first.setAllExpanded(true, ["a", "b", "transcript-only"]);
		first.migrateExpanded("a", "canonical-a", true);
		first.dispose();

		const resumed = new FileActivityStore({ rootDir: stateRoot });
		const snapshot = resumed.bindSession("session-a");
		expect(snapshot.expansion).toEqual({ b: true, "canonical-a": true, "transcript-only": true });
		expect(snapshot.defaultExpansion).toBe(true);
		const uiPath = activityPaths("session-a", stateRoot).uiFile;
		if (process.platform !== "win32") expect(statSync(uiPath).mode & 0o777).toBe(0o600);
		resumed.dispose();
	});

	it("does not overwrite an unknown-schema UI document", () => {
		const stateRoot = root();
		const uiPath = activityPaths("session-a", stateRoot).uiFile;
		atomicWritePrivateJson(uiPath, { schemaVersion: 999, ownerSessionId: "session-a", retained: "future-ui" });
		const store = new FileActivityStore({ rootDir: stateRoot, now: () => 3_000 });
		store.bindSession("session-a");
		store.setExpanded("a", false);
		expect(JSON.parse(readFileSync(uiPath, "utf8"))).toMatchObject({ schemaVersion: 999, retained: "future-ui" });
		store.dispose();
	});

	it("rejects oversized expansion IDs before serializing host UI state", () => {
		const stateRoot = root();
		const store = new FileActivityStore({ rootDir: stateRoot, now: () => 3_000 });
		store.bindSession("session-a");
		store.setExpanded("valid", false);
		store.setExpanded("x".repeat(5 * 1024 * 1024), true);
		store.setAllExpanded(true, ["valid", "🧘".repeat(200)]);
		expect(store.getSnapshot().expansion).toEqual({ valid: true });
		const uiPath = activityPaths("session-a", stateRoot).uiFile;
		expect(statSync(uiPath).size).toBeLessThan(4 * 1024 * 1024);
		store.dispose();
	});

	it("clears watchers, debounce/poll timers, and listeners on dispose", () => {
		vi.useFakeTimers();
		const stateRoot = root();
		let closed = 0;
		let callback: (() => void) | undefined;
		const watchImpl = ((_path: string, listener: () => void) => {
			callback = listener;
			const watcher = { on: () => watcher, close: () => { closed += 1; } };
			return watcher;
		}) as unknown as typeof import("node:fs").watch;
		const store = new FileActivityStore({ rootDir: stateRoot, watch: watchImpl, debounceMs: 5, pollMs: 1_000 });
		store.bindSession("session-a");
		callback?.();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		store.dispose();
		expect(closed).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
