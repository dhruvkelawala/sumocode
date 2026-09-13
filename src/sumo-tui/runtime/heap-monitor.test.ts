import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEAP_SAMPLE_INTERVAL_MS, HEAP_SNAPSHOT_ENV, installHeapSnapshotTrigger, startHeapDiagnostics } from "./heap-monitor.js";

const previousDiagFile = process.env.SUMO_TUI_DIAG_FILE;
const previousSnapshotTarget = process.env[HEAP_SNAPSHOT_ENV];
let tempDir: string | undefined;

afterEach(() => {
	vi.useRealTimers();
	if (previousDiagFile === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
	else process.env.SUMO_TUI_DIAG_FILE = previousDiagFile;
	if (previousSnapshotTarget === undefined) delete process.env[HEAP_SNAPSHOT_ENV];
	else process.env[HEAP_SNAPSHOT_ENV] = previousSnapshotTarget;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function tempRoot(): string {
	tempDir = mkdtempSync(join(tmpdir(), "sumocode-heap-"));
	return tempDir;
}

function readEvents(file: string) {
	return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("heap diagnostics", () => {
	it("samples process memory and the supplied counters every 10s", () => {
		vi.useFakeTimers();
		const file = join(tempRoot(), "manual.jsonl");
		process.env.SUMO_TUI_DIAG_FILE = file;
		const counters = { transcriptBlocks: 314, viewModelRows: 4200, retainedFrames: 2, cloneCount: 7 };
		const stop = startHeapDiagnostics(() => counters);

		vi.advanceTimersByTime(HEAP_SAMPLE_INTERVAL_MS);
		stop();
		vi.advanceTimersByTime(HEAP_SAMPLE_INTERVAL_MS);

		const events = readEvents(file);
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe("heap");
		expect(events[0]).toMatchObject(counters);
		expect(events[0]?.rss).toBeGreaterThan(0);
		expect(events[0]?.heapUsed).toBeGreaterThan(0);
		expect(events[0]?.external).toBeGreaterThanOrEqual(0);
	});

	it("stays inert without a diagnostics file", () => {
		vi.useFakeTimers();
		delete process.env.SUMO_TUI_DIAG_FILE;
		const sample = vi.fn(() => ({ transcriptBlocks: 0, viewModelRows: 0, retainedFrames: 0, cloneCount: 0 }));
		const stop = startHeapDiagnostics(sample);

		vi.advanceTimersByTime(HEAP_SAMPLE_INTERVAL_MS * 2);
		stop();

		expect(sample).not.toHaveBeenCalled();
	});

	it("writes a heap snapshot on SIGUSR2 only when SUMOCODE_HEAP_SNAPSHOT is set", () => {
		const root = tempRoot();
		const diagFile = join(root, "manual.jsonl");
		process.env.SUMO_TUI_DIAG_FILE = diagFile;
		const listeners = process.listenerCount("SIGUSR2");
		delete process.env[HEAP_SNAPSHOT_ENV];
		installHeapSnapshotTrigger()();
		expect(process.listenerCount("SIGUSR2")).toBe(listeners);

		const snapshot = join(root, "host.heapsnapshot");
		process.env[HEAP_SNAPSHOT_ENV] = snapshot;
		const stop = installHeapSnapshotTrigger();
		try {
			expect(process.listenerCount("SIGUSR2")).toBe(listeners + 1);
			process.emit("SIGUSR2");
			expect(existsSync(snapshot)).toBe(true);
			expect(statSync(snapshot).size).toBeGreaterThan(0);
		} finally {
			stop();
		}

		expect(process.listenerCount("SIGUSR2")).toBe(listeners);
		const events = readEvents(diagFile).filter((event) => event.event === "heap_snapshot");
		expect(events).toHaveLength(1);
		expect(events[0]?.file).toBe(snapshot);
	});
});
