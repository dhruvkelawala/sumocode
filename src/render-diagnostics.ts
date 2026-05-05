/**
 * Per-render timing instrumentation for SumoCode chrome.
 *
 * Activates only when `SUMO_TUI_DIAG_FILE` is set (i.e. `sumocode -d`). Wraps
 * `ctx.ui.setFooter / setHeader / setEditorComponent / setWidget` so every
 * `render(width)` call from Pi's draw cycle is timed and aggregated.
 *
 * Output (JSONL into the diagnostics file):
 *   • `render_sample` — one entry per render, written sparsely (only when
 *     `durationMs >= SLOW_RENDER_THRESHOLD_MS`) so the file does not balloon.
 *   • `render_stats` — emitted once per `STATS_FLUSH_MS` interval with per-target
 *     count, total ms, max ms, plus session-branch traversal counters (so we
 *     can verify the session-cache actually works).
 *
 * Design:
 *   - Zero overhead when diagnostics are disabled — `installRenderDiagnostics`
 *     short-circuits.
 *   - Non-invasive — patches `render` on the returned component (and `getBranch`
 *     on the session manager) but keeps prototypes/identity intact, so
 *     `CathedralEditor` keeps working.
 *   - Must install BEFORE consumers (`installFooter`, `installSidebar`, etc.)
 *     so its `setFooter` etc. wrappers are in place when those modules wire
 *     their components.
 */

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isDiagnosticsEnabled, logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";

/** Render durations >= this (ms) get logged individually as `render_sample`. */
const SLOW_RENDER_THRESHOLD_MS = 4;
/** stdout.write durations >= this (ms) get logged individually as `stdout_slow`. */
const SLOW_STDOUT_THRESHOLD_MS = 4;
/** Keystroke->paint latencies >= this (ms) get logged individually. */
const SLOW_KEYSTROKE_THRESHOLD_MS = 32;
/** stdin handler durations >= this get logged individually as `stdin_handler_slow`. */
const SLOW_STDIN_HANDLER_THRESHOLD_MS = 16;
/** Event-loop lag samples >= this get logged individually as `event_loop_lag`. */
const SLOW_EVENT_LOOP_LAG_MS = 50;
/** How often (ms) the event-loop-lag probe schedules itself. */
const EVENT_LOOP_PROBE_MS = 100;
/** Module._load samples >= this get logged individually as `module_load_slow`. */
const SLOW_MODULE_LOAD_MS = 8;
/** How often (ms) to emit aggregated `render_stats`. */
const STATS_FLUSH_MS = 1_000;

type Bucket = {
	count: number;
	totalMs: number;
	maxMs: number;
};

type RenderTarget = "footer" | "header" | "editor" | `widget:${string}`;

type IoBucket = {
	writes: number;
	bytes: number;
	writeMs: number;
	maxWriteMs: number;
	maxBytes: number;
};

type LatencyBucket = {
	count: number;
	totalMs: number;
	maxMs: number;
};

type ModuleLoadStats = {
	count: number;
	totalMs: number;
	maxMs: number;
	slowestSpec: string | undefined;
};

class RenderStats {
	private readonly buckets = new Map<RenderTarget, Bucket>();
	private getBranchCalls = 0;
	private cacheUsageHits = 0;
	private cacheUsageMisses = 0;
	private cacheBranchHits = 0;
	private cacheBranchMisses = 0;
	private cacheBranchChanges = 0;
	private piEvents = 0;
	private keystrokes = 0;
	private keystrokeBytes = 0;
	private readonly stdoutByStream = new Map<"stdout" | "stderr", IoBucket>();
	private readonly keystrokeLatency: LatencyBucket = { count: 0, totalMs: 0, maxMs: 0 };
	private readonly stdinHandlerLatency: LatencyBucket = { count: 0, totalMs: 0, maxMs: 0 };
	private readonly eventLoopLag: LatencyBucket = { count: 0, totalMs: 0, maxMs: 0 };
	private readonly moduleLoad: ModuleLoadStats = { count: 0, totalMs: 0, maxMs: 0, slowestSpec: undefined };
	private flushTimer: ReturnType<typeof setInterval> | undefined;

	public start(): void {
		if (this.flushTimer) return;
		this.flushTimer = setInterval(() => this.flush(), STATS_FLUSH_MS);
		// Don't keep the process alive for diagnostics flushing.
		this.flushTimer.unref?.();
	}

	public stop(): void {
		if (this.flushTimer) clearInterval(this.flushTimer);
		this.flushTimer = undefined;
		this.flush();
	}

	public recordRender(target: RenderTarget, durationMs: number, width: number, lines: number): void {
		const bucket = this.buckets.get(target) ?? { count: 0, totalMs: 0, maxMs: 0 };
		bucket.count += 1;
		bucket.totalMs += durationMs;
		if (durationMs > bucket.maxMs) bucket.maxMs = durationMs;
		this.buckets.set(target, bucket);

		if (durationMs >= SLOW_RENDER_THRESHOLD_MS) {
			logDiagnostic("render_sample", { target, durationMs: round(durationMs), width, lines });
		}
	}

	public recordGetBranch(): void {
		this.getBranchCalls += 1;
	}

	public recordCacheUsageHit(): void {
		this.cacheUsageHits += 1;
	}

	public recordCacheUsageMiss(): void {
		this.cacheUsageMisses += 1;
	}

	public recordCacheBranchHit(): void {
		this.cacheBranchHits += 1;
	}

	public recordCacheBranchMiss(): void {
		this.cacheBranchMisses += 1;
	}

	public recordCacheBranchChange(): void {
		this.cacheBranchChanges += 1;
	}

	public recordPiEvent(): void {
		this.piEvents += 1;
	}

	public recordKeystroke(bytes: number): void {
		this.keystrokes += 1;
		this.keystrokeBytes += bytes;
	}

	public recordKeystrokeLatency(durationMs: number, bytes: number): void {
		this.keystrokeLatency.count += 1;
		this.keystrokeLatency.totalMs += durationMs;
		if (durationMs > this.keystrokeLatency.maxMs) this.keystrokeLatency.maxMs = durationMs;
		if (durationMs >= SLOW_KEYSTROKE_THRESHOLD_MS) {
			logDiagnostic("keystroke_slow", { durationMs: round(durationMs), bytes });
		}
	}

	public recordStdinHandler(durationMs: number, bytes: number): void {
		this.stdinHandlerLatency.count += 1;
		this.stdinHandlerLatency.totalMs += durationMs;
		if (durationMs > this.stdinHandlerLatency.maxMs) this.stdinHandlerLatency.maxMs = durationMs;
		if (durationMs >= SLOW_STDIN_HANDLER_THRESHOLD_MS) {
			logDiagnostic("stdin_handler_slow", { durationMs: round(durationMs), bytes });
		}
	}

	public recordEventLoopLag(actualMs: number, expectedMs: number): void {
		const lag = Math.max(0, actualMs - expectedMs);
		this.eventLoopLag.count += 1;
		this.eventLoopLag.totalMs += lag;
		if (lag > this.eventLoopLag.maxMs) this.eventLoopLag.maxMs = lag;
		if (lag >= SLOW_EVENT_LOOP_LAG_MS) {
			logDiagnostic("event_loop_lag", { lagMs: round(lag), actualMs: round(actualMs), expectedMs });
		}
	}

	public recordModuleLoad(spec: string, durationMs: number): void {
		this.moduleLoad.count += 1;
		this.moduleLoad.totalMs += durationMs;
		if (durationMs > this.moduleLoad.maxMs) {
			this.moduleLoad.maxMs = durationMs;
			this.moduleLoad.slowestSpec = spec;
		}
		if (durationMs >= SLOW_MODULE_LOAD_MS) {
			logDiagnostic("module_load_slow", { spec, durationMs: round(durationMs) });
		}
	}

	public recordWrite(stream: "stdout" | "stderr", bytes: number, durationMs: number): void {
		const bucket = this.stdoutByStream.get(stream) ?? { writes: 0, bytes: 0, writeMs: 0, maxWriteMs: 0, maxBytes: 0 };
		bucket.writes += 1;
		bucket.bytes += bytes;
		bucket.writeMs += durationMs;
		if (durationMs > bucket.maxWriteMs) bucket.maxWriteMs = durationMs;
		if (bytes > bucket.maxBytes) bucket.maxBytes = bytes;
		this.stdoutByStream.set(stream, bucket);

		if (durationMs >= SLOW_STDOUT_THRESHOLD_MS) {
			logDiagnostic("stdout_slow", { stream, bytes, durationMs: round(durationMs) });
		}
	}

	private flush(): void {
		const nothingToReport =
			this.buckets.size === 0 &&
			this.getBranchCalls === 0 &&
			this.cacheUsageHits === 0 &&
			this.cacheUsageMisses === 0 &&
			this.cacheBranchHits === 0 &&
			this.cacheBranchMisses === 0 &&
			this.cacheBranchChanges === 0 &&
			this.piEvents === 0 &&
			this.keystrokes === 0 &&
			this.stdoutByStream.size === 0 &&
			this.keystrokeLatency.count === 0 &&
			this.stdinHandlerLatency.count === 0 &&
			this.eventLoopLag.count === 0 &&
			this.moduleLoad.count === 0;
		if (nothingToReport) return;

		const targets: Record<string, Bucket & { avgMs: number }> = {};
		for (const [target, bucket] of this.buckets.entries()) {
			targets[target] = {
				count: bucket.count,
				totalMs: round(bucket.totalMs),
				maxMs: round(bucket.maxMs),
				avgMs: round(bucket.totalMs / bucket.count),
			};
		}
		const io: Record<string, IoBucket & { avgWriteMs: number; avgBytes: number }> = {};
		for (const [stream, bucket] of this.stdoutByStream.entries()) {
			io[stream] = {
				writes: bucket.writes,
				bytes: bucket.bytes,
				writeMs: round(bucket.writeMs),
				maxWriteMs: round(bucket.maxWriteMs),
				maxBytes: bucket.maxBytes,
				avgWriteMs: round(bucket.writeMs / bucket.writes),
				avgBytes: Math.round(bucket.bytes / bucket.writes),
			};
		}
		const keystrokeStats = this.keystrokeLatency.count > 0
			? {
				count: this.keystrokeLatency.count,
				totalMs: round(this.keystrokeLatency.totalMs),
				maxMs: round(this.keystrokeLatency.maxMs),
				avgMs: round(this.keystrokeLatency.totalMs / this.keystrokeLatency.count),
			}
			: undefined;
		const stdinHandlerStats = this.stdinHandlerLatency.count > 0
			? {
				count: this.stdinHandlerLatency.count,
				totalMs: round(this.stdinHandlerLatency.totalMs),
				maxMs: round(this.stdinHandlerLatency.maxMs),
				avgMs: round(this.stdinHandlerLatency.totalMs / this.stdinHandlerLatency.count),
			}
			: undefined;
		const loopLagStats = this.eventLoopLag.count > 0
			? {
				count: this.eventLoopLag.count,
				totalMs: round(this.eventLoopLag.totalMs),
				maxMs: round(this.eventLoopLag.maxMs),
				avgMs: round(this.eventLoopLag.totalMs / this.eventLoopLag.count),
			}
			: undefined;
		const moduleLoadStats = this.moduleLoad.count > 0
			? {
				count: this.moduleLoad.count,
				totalMs: round(this.moduleLoad.totalMs),
				maxMs: round(this.moduleLoad.maxMs),
				avgMs: round(this.moduleLoad.totalMs / this.moduleLoad.count),
				slowestSpec: this.moduleLoad.slowestSpec,
			}
			: undefined;
		logDiagnostic("render_stats", {
			windowMs: STATS_FLUSH_MS,
			targets,
			io,
			getBranchCalls: this.getBranchCalls,
			sessionCacheHits: this.cacheUsageHits,
			sessionCacheMisses: this.cacheUsageMisses,
			branchCacheHits: this.cacheBranchHits,
			branchCacheMisses: this.cacheBranchMisses,
			branchCacheChanges: this.cacheBranchChanges,
			piEvents: this.piEvents,
			keystrokes: this.keystrokes,
			keystrokeBytes: this.keystrokeBytes,
			keystrokeLatency: keystrokeStats,
			stdinHandler: stdinHandlerStats,
			eventLoopLag: loopLagStats,
			moduleLoad: moduleLoadStats,
		});
		this.buckets.clear();
		this.getBranchCalls = 0;
		this.cacheUsageHits = 0;
		this.cacheUsageMisses = 0;
		this.cacheBranchHits = 0;
		this.cacheBranchMisses = 0;
		this.cacheBranchChanges = 0;
		this.piEvents = 0;
		this.keystrokes = 0;
		this.keystrokeBytes = 0;
		this.stdoutByStream.clear();
		this.keystrokeLatency.count = 0;
		this.keystrokeLatency.totalMs = 0;
		this.keystrokeLatency.maxMs = 0;
		this.stdinHandlerLatency.count = 0;
		this.stdinHandlerLatency.totalMs = 0;
		this.stdinHandlerLatency.maxMs = 0;
		this.eventLoopLag.count = 0;
		this.eventLoopLag.totalMs = 0;
		this.eventLoopLag.maxMs = 0;
		this.moduleLoad.count = 0;
		this.moduleLoad.totalMs = 0;
		this.moduleLoad.maxMs = 0;
		this.moduleLoad.slowestSpec = undefined;
	}
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

const GLOBAL_RENDER_STATS_KEY = "__sumoRenderDiagnosticsStats";
const GLOBAL_EVENT_LOOP_PROBE_KEY = "__sumoRenderDiagnosticsEventLoopProbeStarted";
type GlobalWithRenderDiagnostics = typeof globalThis & {
	[GLOBAL_RENDER_STATS_KEY]?: RenderStats;
	[GLOBAL_EVENT_LOOP_PROBE_KEY]?: boolean;
};
const globalForRenderDiagnostics = globalThis as GlobalWithRenderDiagnostics;
if (!globalForRenderDiagnostics[GLOBAL_RENDER_STATS_KEY]) globalForRenderDiagnostics[GLOBAL_RENDER_STATS_KEY] = new RenderStats();
const stats = globalForRenderDiagnostics[GLOBAL_RENDER_STATS_KEY] as RenderStats;

/** Counters that other modules can poke into. No-op when diagnostics are disabled. */
export const renderDiagnosticsCounters = {
	noteCacheHit(): void {
		if (isDiagnosticsEnabled()) stats.recordCacheUsageHit();
	},
	noteCacheMiss(): void {
		if (isDiagnosticsEnabled()) stats.recordCacheUsageMiss();
	},
	noteBranchCacheHit(): void {
		if (isDiagnosticsEnabled()) stats.recordCacheBranchHit();
	},
	noteBranchCacheMiss(): void {
		if (isDiagnosticsEnabled()) stats.recordCacheBranchMiss();
	},
	noteBranchChange(): void {
		if (isDiagnosticsEnabled()) stats.recordCacheBranchChange();
	},
} as const;

type RenderableComponent = { render(width: number): string[] };

function patchRender(target: RenderTarget, component: RenderableComponent): void {
	const original = component.render.bind(component);
	component.render = (width: number): string[] => {
		const start = performance.now();
		const result = original(width);
		const duration = performance.now() - start;
		stats.recordRender(target, duration, width, Array.isArray(result) ? result.length : 0);
		return result;
	};
}

type UiLike = {
	setFooter?: (factory: unknown) => void;
	setHeader?: (factory: unknown) => void;
	setEditorComponent?: (factory: unknown) => void;
	setWidget?: (key: string, contentOrFactory: unknown, options?: unknown) => void;
};

function instrumentUi(ctx: ExtensionContext): void {
	const ui = ctx.ui as unknown as UiLike;
	if (!ui) return;

	if (typeof ui.setFooter === "function") {
		const original = ui.setFooter.bind(ui) as (factory: unknown) => void;
		ui.setFooter = (factory: unknown): void => {
			if (typeof factory !== "function") return original(factory);
			const wrapped = (...args: unknown[]): unknown => {
				const result = (factory as (...a: unknown[]) => unknown)(...args);
				if (result && typeof (result as RenderableComponent).render === "function") {
					patchRender("footer", result as RenderableComponent);
				}
				return result;
			};
			return original(wrapped);
		};
	}

	if (typeof ui.setHeader === "function") {
		const original = ui.setHeader.bind(ui) as (factory: unknown) => void;
		ui.setHeader = (factory: unknown): void => {
			if (typeof factory !== "function") return original(factory);
			const wrapped = (...args: unknown[]): unknown => {
				const result = (factory as (...a: unknown[]) => unknown)(...args);
				if (result && typeof (result as RenderableComponent).render === "function") {
					patchRender("header", result as RenderableComponent);
				}
				return result;
			};
			return original(wrapped);
		};
	}

	if (typeof ui.setEditorComponent === "function") {
		const original = ui.setEditorComponent.bind(ui) as (factory: unknown) => void;
		ui.setEditorComponent = (factory: unknown): void => {
			if (typeof factory !== "function") return original(factory);
			const wrapped = (...args: unknown[]): unknown => {
				const result = (factory as (...a: unknown[]) => unknown)(...args);
				if (result && typeof (result as RenderableComponent).render === "function") {
					patchRender("editor", result as RenderableComponent);
				}
				return result;
			};
			return original(wrapped);
		};
	}

	if (typeof ui.setWidget === "function") {
		const original = ui.setWidget.bind(ui) as (key: string, content: unknown, options?: unknown) => void;
		ui.setWidget = (key: string, content: unknown, options?: unknown): void => {
			if (typeof content !== "function") return original(key, content, options);
			const wrapped = (...args: unknown[]): unknown => {
				const result = (content as (...a: unknown[]) => unknown)(...args);
				if (result && typeof (result as RenderableComponent).render === "function") {
					patchRender(`widget:${key}`, result as RenderableComponent);
				}
				return result;
			};
			return original(key, wrapped, options);
		};
	}
}

function instrumentSessionManager(ctx: ExtensionContext): void {
	const sm = ctx.sessionManager as unknown as { getBranch?: (...args: unknown[]) => unknown };
	if (!sm || typeof sm.getBranch !== "function") return;
	const original = sm.getBranch.bind(sm);
	sm.getBranch = (...args: unknown[]): unknown => {
		stats.recordGetBranch();
		return original(...args);
	};
}

/**
 * Patch a writable stream's `write` so we can track per-second byte volume +
 * per-call wall time. The underlying tty write is what actually paints the
 * frame on screen — if it's slow, no amount of upstream optimization helps.
 */
function instrumentWritable(stream: NodeJS.WriteStream, label: "stdout" | "stderr"): void {
	const marker = `__sumoTuiDiagnosticsWritePatched_${label}` as const;
	const target = stream as unknown as { [key: string]: unknown; write: NodeJS.WriteStream["write"] };
	if (target[marker]) return;
	const original = target.write.bind(stream) as NodeJS.WriteStream["write"];
	target.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		const start = performance.now();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = (original as unknown as (...args: any[]) => boolean)(chunk, ...(rest as unknown[]));
		const duration = performance.now() - start;
		stats.recordWrite(label, bytes, duration);
		return result;
	}) as NodeJS.WriteStream["write"];
	target[marker] = true;
}

/**
 * Wrap `process.stdin` `data` events to (a) count keystrokes / bytes, (b)
 * derive keystroke→paint latency by hooking the next stdout write, and (c)
 * time the *synchronous* portion of the listener chain that runs in response
 * to each chunk. (c) is what we need to find the cold-path freeze on `/`
 * — the difference between (a)+(b) and (c) tells us whether the freeze is
 * inside the listener chain or downstream (next-tick / setImmediate).
 */
function instrumentStdin(): void {
	const stdin = process.stdin as NodeJS.ReadStream & { __sumoTuiDiagnosticsStdinPatched?: true };
	if (stdin.__sumoTuiDiagnosticsStdinPatched) return;
	stdin.__sumoTuiDiagnosticsStdinPatched = true;

	let pendingSince: number | undefined;
	let pendingBytes = 0;

	// Patch stdin.emit so we can wrap the entire listener chain for "data".
	// Listeners attached BEFORE this patch as well as AFTER all run inside the
	// timed window when the emit happens. This catches Pi's input handler.
	type StdinWithEmit = NodeJS.ReadStream & {
		emit(eventName: string | symbol, ...args: unknown[]): boolean;
	};
	const stdinTyped = stdin as StdinWithEmit;
	const originalEmit = stdinTyped.emit.bind(stdinTyped);
	stdinTyped.emit = ((eventName: string | symbol, ...args: unknown[]): boolean => {
		if (eventName !== "data") return originalEmit(eventName, ...args);
		const chunk = args[0] as Buffer | string | undefined;
		const bytes = chunk === undefined ? 0 : typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		stats.recordKeystroke(bytes);
		// Log the raw bytes so investigators can see exactly what the terminal
		// produced for any given keypress. Capped at 64 bytes (paste chunks can
		// be huge). This is what we need to debug Shift+Enter and other
		// modifier-aware keys without speculation.
		if (chunk !== undefined && bytes > 0) {
			const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			const sliced = buf.subarray(0, 64);
			let hex = "";
			let ascii = "";
			for (const b of sliced) {
				hex += b.toString(16).padStart(2, "0") + " ";
				ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
			}
			logDiagnostic("stdin_raw", {
				bytes,
				truncated: bytes > 64,
				hex: hex.trimEnd(),
				ascii,
			});
		}
		if (pendingSince === undefined) {
			pendingSince = performance.now();
			pendingBytes = bytes;
		} else {
			pendingBytes += bytes;
		}
		const start = performance.now();
		const result = originalEmit(eventName, ...args);
		const duration = performance.now() - start;
		stats.recordStdinHandler(duration, bytes);
		return result;
	}) as StdinWithEmit["emit"];

	// Hook the next stdout write after a keystroke; close the loop and reset.
	// This is intentionally approximate — we capture latency to the first paint
	// that follows a stdin event, which is what the user feels.
	// NOTE: pendingSince/pendingBytes are shared with the emit wrapper above.
	//
	const stdoutPatchedKey = "__sumoTuiDiagnosticsKeystrokeLatencyHooked";
	const stdoutTarget = process.stdout as unknown as { [k: string]: unknown; write: NodeJS.WriteStream["write"] };
	if (stdoutTarget[stdoutPatchedKey]) return;
	stdoutTarget[stdoutPatchedKey] = true;
	const originalWrite = stdoutTarget.write.bind(process.stdout) as NodeJS.WriteStream["write"];
	stdoutTarget.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		if (pendingSince !== undefined) {
			const duration = performance.now() - pendingSince;
			stats.recordKeystrokeLatency(duration, pendingBytes);
			pendingSince = undefined;
			pendingBytes = 0;
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (originalWrite as unknown as (...args: any[]) => boolean)(chunk, ...(rest as unknown[]));
	}) as NodeJS.WriteStream["write"];
}

/**
 * Patch `Module.prototype.require` (CJS) to time every load synchronously.
 * Catches lazy-loaded modules: jiti compiles a TS file the first time it is
 * required, which can block the event loop. ESM dynamic imports are not
 * captured here — they're async and don't block the input handler.
 *
 * No-op if anything goes wrong (tests, ESM-only environments, custom loaders).
 */
function instrumentModuleLoad(): void {
	type RequireRecord = {
		prototype?: { require?: (id: string) => unknown };
		__sumoTuiDiagnosticsModuleLoadPatched?: true;
	};
	try {
		const require = createRequire(import.meta.url);
		const Module = require("module") as RequireRecord;
		if (Module.__sumoTuiDiagnosticsModuleLoadPatched) return;
		const proto = Module.prototype;
		if (!proto || typeof proto.require !== "function") return;
		const original = proto.require;
		proto.require = function patchedRequire(this: unknown, id: string) {
			const start = performance.now();
			try {
				return original.call(this, id);
			} finally {
				const duration = performance.now() - start;
				stats.recordModuleLoad(id, duration);
			}
		};
		Module.__sumoTuiDiagnosticsModuleLoadPatched = true;
	} catch {
		// Ignore — diagnostics must never crash the session.
	}
}

/**
 * Periodically schedules `setImmediate` and measures actual delay vs target.
 * Any work that blocks the event loop — sync IO, jiti compile, GC pause,
 * heavy synchronous handlers — inflates the delay. This is the canonical
 * way to detect "something is blocking the event loop" without knowing what.
 */
function startEventLoopLagProbe(): void {
	if (globalForRenderDiagnostics[GLOBAL_EVENT_LOOP_PROBE_KEY]) return;
	globalForRenderDiagnostics[GLOBAL_EVENT_LOOP_PROBE_KEY] = true;
	let lastTick = performance.now();
	const probe = (): void => {
		const now = performance.now();
		const elapsed = now - lastTick;
		stats.recordEventLoopLag(elapsed, EVENT_LOOP_PROBE_MS);
		lastTick = now;
		const t = setTimeout(probe, EVENT_LOOP_PROBE_MS);
		t.unref?.();
	};
	const t = setTimeout(probe, EVENT_LOOP_PROBE_MS);
	t.unref?.();
}

function instrumentPiEvents(pi: ExtensionAPI): void {
	const marker = "__sumoTuiDiagnosticsRenderPiInstrumented" as const;
	const target = pi as unknown as { [k: string]: unknown; on: ExtensionAPI["on"] };
	if (target[marker]) return;
	const originalOn = target.on.bind(pi) as ExtensionAPI["on"];
	target.on = ((eventName: string, handler: (...args: unknown[]) => unknown) => {
		if (typeof handler !== "function") return originalOn(eventName as never, handler as never);
		const wrapped = (...args: unknown[]): unknown => {
			stats.recordPiEvent();
			return handler(...args);
		};
		return originalOn(eventName as never, wrapped as never);
	}) as ExtensionAPI["on"];
	target[marker] = true;
}

/**
 * Install render-time instrumentation. No-op unless diagnostics are enabled.
 *
 * Call this BEFORE installing footer/sidebar/top-chrome/editor — otherwise
 * those modules will have already wired their components through unwrapped
 * `setFooter` / `setHeader` / `setEditorComponent` / `setWidget` calls.
 */
export function installRenderDiagnostics(pi: ExtensionAPI): void {
	if (!isDiagnosticsEnabled()) return;

	stats.start();
	logDiagnostic("render_diagnostics_install", {
		renderThresholdMs: SLOW_RENDER_THRESHOLD_MS,
		stdoutThresholdMs: SLOW_STDOUT_THRESHOLD_MS,
		keystrokeThresholdMs: SLOW_KEYSTROKE_THRESHOLD_MS,
		flushMs: STATS_FLUSH_MS,
	});

	instrumentWritable(process.stdout, "stdout");
	instrumentWritable(process.stderr, "stderr");
	instrumentStdin();
	instrumentPiEvents(pi);
	instrumentModuleLoad();
	startEventLoopLagProbe();

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		instrumentUi(ctx);
		instrumentSessionManager(ctx);
		logDiagnostic("render_diagnostics_session", { cwd: ctx.cwd });
	});
}
