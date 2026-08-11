import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { CachedChrome } from "./chrome-cache.js";

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");

(async () => {
	const importedJiti = await import(pathToFileURL(workerData.jitiPath).href);
	const jiti = importedJiti.createJiti(workerData.modulePath, {
		moduleCache: true,
		tryNative: false,
	});
	const cache = await jiti.import(workerData.modulePath);
	let operations = Promise.resolve();
	parentPort.on("message", (request) => {
		operations = operations.then(async () => {
			try {
				if (workerData.operationDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, workerData.operationDelayMs));
				}
				const options = { stateRoot: workerData.stateRoot };
				const value = request.operation === "read"
					? cache.readCachedChrome(request.cwd, options)
					: (cache.writeCachedChrome(request.cwd, request.chrome, options), true);
				parentPort.postMessage({ id: request.id, value });
			} catch (error) {
				parentPort.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
			}
		});
	});
})().catch((error) => {
	parentPort.postMessage({ fatal: error instanceof Error ? error.message : String(error) });
});
`;

interface ChromeCacheWorkerRequest {
	readonly id: number;
	readonly operation: "read" | "write";
	readonly cwd: string;
	readonly chrome?: CachedChrome;
}

interface ChromeCacheWorkerReply {
	readonly id?: number;
	readonly value?: unknown;
	readonly error?: string;
	readonly fatal?: string;
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
	private readonly pending = new Map<number, (value: unknown) => void>();

	public constructor(private readonly options: ChromeCacheWorkerClientOptions) {}

	public async read(cwd: string): Promise<CachedChrome | undefined> {
		const value = await this.request({ operation: "read", cwd });
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as Record<string, unknown>;
		return {
			...(typeof record.modelLabel === "string" ? { modelLabel: record.modelLabel } : {}),
			...(typeof record.thinkingLevel === "string" ? { thinkingLevel: record.thinkingLevel } : {}),
		};
	}

	public async write(cwd: string, chrome: CachedChrome): Promise<void> {
		await this.request({ operation: "write", cwd, chrome });
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const worker = this.worker;
		this.worker = undefined;
		this.settlePending();
		if (worker) await worker.terminate().catch(() => undefined);
	}

	private request(request: Omit<ChromeCacheWorkerRequest, "id">): Promise<unknown> {
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
		const require = createRequire(import.meta.url);
		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: {
				stateRoot: this.options.stateRoot,
				modulePath: this.options.modulePath,
				jitiPath: require.resolve("jiti"),
				operationDelayMs: Math.max(0, this.options.operationDelayMs ?? 0),
			},
		});
		worker.unref();
		worker.on("message", (reply: ChromeCacheWorkerReply) => {
			if (reply.fatal !== undefined) {
				if (this.worker === worker) this.worker = undefined;
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
		worker.on("error", () => this.settlePending());
		worker.on("exit", () => {
			if (this.worker === worker) this.worker = undefined;
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
