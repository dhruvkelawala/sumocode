import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { isNativeRuntime } from "../../native/paths.js";
import type { CachedChrome } from "./chrome-cache.js";
import { CHROME_CACHE_WORKER_EVAL_SOURCE } from "./chrome-cache-worker.js";

/** Payload the worker posts back for a completed request (reads: chrome; writes: ack). */
interface ChromeCacheReadValue extends CachedChrome {}
type ChromeCacheWorkerValue = ChromeCacheReadValue | boolean | undefined;

function isCachedChrome(value: ChromeCacheWorkerValue): value is ChromeCacheReadValue {
	return typeof value === "object";
}

interface ChromeCacheWorkerRequest {
	readonly id: number;
	readonly operation: "read" | "write";
	readonly cwd: string;
	readonly chrome?: CachedChrome;
}

interface ChromeCacheWorkerReply {
	readonly id?: number;
	readonly value?: ChromeCacheWorkerValue;
	readonly error?: string;
	readonly fatal?: string;
}

export const CHROME_CACHE_SHUTDOWN_GRACE_MS = 2_500;

export async function drainChromeCacheForShutdown(
	drain: () => Promise<void>,
	dispose: () => Promise<void>,
	graceMs = CHROME_CACHE_SHUTDOWN_GRACE_MS,
): Promise<"drained" | "timed-out"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const completeDrainAndDispose = (async () => {
		try {
			await drain();
		} finally {
			await dispose();
		}
	})().then(() => true, () => true);
	const completed = await Promise.race([
		completeDrainAndDispose,
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), Math.max(0, graceMs));
		}),
	]);
	if (timer) clearTimeout(timer);
	if (completed) return "drained";
	// Worker is unrefed. Trigger termination but do not await a native syscall
	// that already exceeded the advisory shutdown budget. If disposal itself
	// was the stalled phase, the idempotent second call returns immediately.
	void dispose();
	return "timed-out";
}

export interface ChromeCacheWorkerClientOptions {
	readonly stateRoot: string;
	readonly modulePath: string;
	/** Test seam proving worker delay does not block the caller's event loop. */
	readonly operationDelayMs?: number;
}

/**
 * Runs advisory chrome-cache reads, lock contention, and fsyncs in one lazy,
 * unrefed worker. The TUI thread only posts messages and applies completed
 * reads; cross-process serialization remains owned by chrome-cache.ts.
 */
export class ChromeCacheWorkerClient {
	private worker: Worker | undefined;
	private nextId = 0;
	private disposed = false;
	private readonly pending = new Map<number, (value: ChromeCacheWorkerValue) => void>();

	public constructor(private readonly options: ChromeCacheWorkerClientOptions) {}

	public async read(cwd: string): Promise<CachedChrome | undefined> {
		try {
			const value = await this.request({ operation: "read", cwd });
			if (!isCachedChrome(value)) return undefined;
			const result: CachedChrome = {};
			if (value.modelLabel !== undefined) result.modelLabel = value.modelLabel;
			if (value.thinkingLevel !== undefined) result.thinkingLevel = value.thinkingLevel;
			return result;
		} catch {
			return undefined;
		}
	}

	public async write(cwd: string, chrome: CachedChrome): Promise<void> {
		try {
			await this.request({ operation: "write", cwd, chrome });
		} catch {
			// Cache persistence is advisory; worker startup/resource failure is inert.
		}
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const worker = this.worker;
		this.worker = undefined;
		this.settlePending();
		if (worker) await worker.terminate().catch(() => undefined);
	}

	private request(request: Omit<ChromeCacheWorkerRequest, "id">): Promise<ChromeCacheWorkerValue> {
		if (this.disposed) return Promise.resolve(undefined);
		const worker = this.ensureWorker();
		const id = ++this.nextId;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			worker.postMessage({ ...request, id } satisfies ChromeCacheWorkerRequest);
		});
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		// Plan 117 seam 2: dev/Node keeps the eval'd jiti bootstrap verbatim;
		// native starts the embedded compiled worker entry (no jiti on disk).
		let worker: Worker;
		if (isNativeRuntime()) {
			// Bun 1.4.0 embeds secondary compile entries under
			// `$bunfs/root/<root-relative-without-src>.js`; import.meta.url for the
			// compiled main is `$bunfs/root/sumocode`. This relative URL reaches the
			// embedded worker without a Bun API or disk path.
			worker = new Worker(new URL("sumo-tui/rpc/chrome-cache-worker.js", import.meta.url), {
				workerData: {
					stateRoot: this.options.stateRoot,
					modulePath: this.options.modulePath,
					operationDelayMs: Math.max(0, this.options.operationDelayMs ?? 0),
				},
			});
		} else {
			const require = createRequire(import.meta.url);
			worker = new Worker(CHROME_CACHE_WORKER_EVAL_SOURCE, {
				eval: true,
				workerData: {
					stateRoot: this.options.stateRoot,
					modulePath: this.options.modulePath,
					jitiPath: require.resolve("jiti"),
					operationDelayMs: Math.max(0, this.options.operationDelayMs ?? 0),
				},
			});
		}
		worker.unref();
		worker.on("message", (reply: ChromeCacheWorkerReply) => {
			if (reply.fatal !== undefined) {
				if (this.worker !== worker) return;
				this.worker = undefined;
				this.settlePending();
				void worker.terminate();
				return;
			}
			if (reply.id === undefined) return;
			const resolve = this.pending.get(reply.id);
			if (!resolve) return;
			this.pending.delete(reply.id);
			resolve(reply.error === undefined ? reply.value : undefined);
		});
		worker.on("error", () => {
			if (this.worker !== worker) return;
			this.worker = undefined;
			this.settlePending();
		});
		worker.on("exit", () => {
			if (this.worker !== worker) return;
			this.worker = undefined;
			this.settlePending();
		});
		this.worker = worker;
		return worker;
	}

	private settlePending(): void {
		for (const resolve of this.pending.values()) resolve(undefined);
		this.pending.clear();
	}
}
