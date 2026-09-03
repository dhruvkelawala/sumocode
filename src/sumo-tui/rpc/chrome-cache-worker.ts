import { pathToFileURL } from "node:url";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import type { CachedChrome, ChromeCacheOptions } from "./chrome-cache.js";

/**
 * Chrome-cache worker module (plan 117 seam 2).
 *
 * One protocol, two bootstraps:
 * - Dev/Node: the client evaluates `CHROME_CACHE_WORKER_EVAL_SOURCE` with
 *   `eval: true`, keeping the original jiti mechanics byte-for-byte (a Node
 *   worker cannot load TypeScript directly).
 * - Native: this file is a compiled worker entry embedded in the binary; the
 *   client starts it via `new Worker(new URL(...))` and the bootstrap below
 *   imports the bundled cache module directly (no jiti on disk).
 *
 * Protocol (both directions): requests `{ id, operation: "read"|"write",
 * cwd, chrome? }`; replies `{ id, value }`, `{ id, error }`, or a fatal
 * `{ fatal }` before the loop starts.
 */

export interface ChromeCacheWorkerData {
	readonly stateRoot: string;
	readonly modulePath: string;
	/** Present only on the dev/Node path (jiti mechanics). */
	readonly jitiPath?: string;
	readonly operationDelayMs?: number;
}

interface ChromeCacheModule {
	readCachedChrome(cwd: string, options?: ChromeCacheOptions): CachedChrome | undefined;
	writeCachedChrome(cwd: string, chrome: CachedChrome, options?: ChromeCacheOptions): void;
}

interface CacheRequest {
	readonly id: number;
	readonly operation: "read" | "write";
	readonly cwd: string;
	readonly chrome?: CachedChrome;
}

/**
 * Dev/Node worker bootstrap. The jiti path arrives via workerData because the
 * eval'd loader cannot resolve host modules itself. Kept verbatim from the
 * pre-seam implementation so dev behavior and its tests are untouched.
 */
export const CHROME_CACHE_WORKER_EVAL_SOURCE = String.raw`
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

async function loadCacheModule(data: ChromeCacheWorkerData): Promise<ChromeCacheModule> {
	if (data.jitiPath) {
		const importedJiti = await import(pathToFileURL(data.jitiPath).href);
		const jiti = importedJiti.createJiti(data.modulePath, {
			moduleCache: true,
			tryNative: false,
		});
		// SAFETY: modulePath is the host-owned chrome-cache.ts path; its exported
		// shape is exercised by the existing worker round-trip tests.
		return await jiti.import(data.modulePath) as ChromeCacheModule;
	}
	// Native: the cache module is bundled into this worker entry.
	return await import("./chrome-cache.js");
}

/** Native worker bootstrap: load the cache, then serialize requests. */
export async function runChromeCacheWorker(
	port: MessagePort,
	data: ChromeCacheWorkerData,
): Promise<void> {
	const cache = await loadCacheModule(data);
	let operations = Promise.resolve();
	port.on("message", (request: CacheRequest) => {
		operations = operations.then(async () => {
			try {
				if ((data.operationDelayMs ?? 0) > 0) {
					await new Promise((resolve) => setTimeout(resolve, data.operationDelayMs));
				}
				const options = { stateRoot: data.stateRoot };
				if (request.operation === "read") {
					port.postMessage({ id: request.id, value: cache.readCachedChrome(request.cwd, options) });
					return;
				}
				const chrome = request.chrome;
				if (chrome === undefined) throw new Error("chrome-cache write request is missing chrome state");
				cache.writeCachedChrome(request.cwd, chrome, options);
				port.postMessage({ id: request.id, value: true });
			} catch (error) {
				port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
			}
		});
	});
}

// Entry-point guard: this module runs as a compiled worker only; importing it
// from the host (for the eval source) leaves parentPort null on both runtimes.
if (parentPort !== null && workerData !== undefined) {
	// SAFETY: only ChromeCacheWorkerClient starts this compiled entry and it
	// supplies exactly ChromeCacheWorkerData as workerData.
	void runChromeCacheWorker(parentPort, workerData as ChromeCacheWorkerData).catch((error) => {
		parentPort!.postMessage({ fatal: error instanceof Error ? error.message : String(error) });
	});
}
