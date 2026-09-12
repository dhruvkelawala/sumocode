/*
 * #521 host memory budget: the retained host had no memory instrumentation, so
 * a 416 MB RSS session could not be split between the transcript view model,
 * the retained frames, and V8 heap growth.
 *
 * Two opt-in hooks, both off by default:
 *   • `heap` — while `SUMO_TUI_DIAG_FILE` is set, one sample every
 *     `HEAP_SAMPLE_INTERVAL_MS` carrying `process.memoryUsage()` plus the
 *     counters that grow with session length (transcript blocks, laid-out
 *     view-model rows, retained frames, frame clones).
 *   • `heap_snapshot` — `SIGUSR2` writes a `v8.writeHeapSnapshot()` for
 *     retained-size analysis. The signal only acts when
 *     `SUMOCODE_HEAP_SNAPSHOT` names the destination (`1` = default path), so
 *     a normal session can never be snapshotted by accident.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { isDiagnosticsEnabled, logDiagnostic } from "./diagnostics.js";

/** Cadence of the `heap` diagnostic once diagnostics are enabled. */
export const HEAP_SAMPLE_INTERVAL_MS = 10_000;

/** Destination for the on-demand heap snapshot; unset disables the signal. */
export const HEAP_SNAPSHOT_ENV = "SUMOCODE_HEAP_SNAPSHOT";

/** Counters the heap sample correlates against process memory. */
export interface HeapSampleCounters {
	/** Blocks in the transcript view model. */
	readonly transcriptBlocks: number;
	/** Rows the chat pager has laid out for the current viewport. */
	readonly viewModelRows: number;
	/** Full-screen `CellBuffer`s the renderer still holds. */
	readonly retainedFrames: number;
	/** Frame clones produced since the renderer was constructed. */
	readonly cloneCount: number;
}

/**
 * Emits a `heap` diagnostic every `HEAP_SAMPLE_INTERVAL_MS`. The timer is
 * unref'd so it can never hold the host open, and the whole hook is inert
 * (returning a no-op stop) without a diagnostics file.
 */
export function startHeapDiagnostics(sample: () => HeapSampleCounters): () => void {
	if (!isDiagnosticsEnabled()) return () => undefined;
	const timer = setInterval(() => {
		const memory = process.memoryUsage();
		logDiagnostic("heap", {
			pid: process.pid,
			rss: memory.rss,
			heapUsed: memory.heapUsed,
			heapTotal: memory.heapTotal,
			external: memory.external,
			arrayBuffers: memory.arrayBuffers,
			...sample(),
		});
	}, HEAP_SAMPLE_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * Installs the on-demand heap snapshot. Requires `SUMOCODE_HEAP_SNAPSHOT`:
 * `1` writes `<tmpdir>/sumocode-heap-<pid>.heapsnapshot`, any other value is
 * used as the destination path. Returns a dispose function; without the env
 * var nothing is installed at all.
 */
export function installHeapSnapshotTrigger(): () => void {
	const target = process.env[HEAP_SNAPSHOT_ENV]?.trim();
	if (!target) return () => undefined;
	const file = target === "1" ? join(tmpdir(), `sumocode-heap-${process.pid}.heapsnapshot`) : target;
	const onSignal = (): void => {
		try {
			logDiagnostic("heap_snapshot", { pid: process.pid, file: writeHeapSnapshot(file) });
		} catch (error) {
			logDiagnostic("heap_snapshot", { pid: process.pid, file, error: error instanceof Error ? error.message : String(error) });
		}
	};
	process.on("SIGUSR2", onSignal);
	return () => process.off("SIGUSR2", onSignal);
}
