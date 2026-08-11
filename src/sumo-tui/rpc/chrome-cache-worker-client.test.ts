import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeCacheWorkerClient, drainChromeCacheForShutdown } from "./chrome-cache-worker-client.js";

const tempDirectories: string[] = [];

function createClient(operationDelayMs = 0): ChromeCacheWorkerClient {
	const stateRoot = mkdtempSync(join(tmpdir(), "sumocode-chrome-worker-"));
	tempDirectories.push(stateRoot);
	return new ChromeCacheWorkerClient({
		stateRoot,
		modulePath: fileURLToPath(new URL("./chrome-cache.ts", import.meta.url)),
		operationDelayMs,
	});
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ChromeCacheWorkerClient", () => {
	it("awaits a completed shutdown drain before disposal", async () => {
		const order: string[] = [];
		await expect(drainChromeCacheForShutdown(
			async () => { order.push("drain"); },
			async () => { order.push("dispose"); },
			50,
		)).resolves.toBe("drained");
		expect(order).toEqual(["drain", "dispose"]);
	});

	it("bounds a stalled shutdown drain and triggers worker termination", async () => {
		const dispose = vi.fn(async () => undefined);
		await expect(drainChromeCacheForShutdown(
			() => new Promise<void>(() => undefined),
			dispose,
			10,
		)).resolves.toBe("timed-out");
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("bounds worker disposal even after the drain itself completed", async () => {
		let disposalStarted = false;
		const dispose = vi.fn(() => {
			if (disposalStarted) return Promise.resolve();
			disposalStarted = true;
			return new Promise<void>(() => undefined);
		});
		await expect(drainChromeCacheForShutdown(
			async () => undefined,
			dispose,
			10,
		)).resolves.toBe("timed-out");
		expect(dispose).toHaveBeenCalledTimes(2);
	});

	it("swallows worker bootstrap failures for advisory reads", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "sumocode-chrome-worker-invalid-"));
		tempDirectories.push(stateRoot);
		const client = new ChromeCacheWorkerClient({
			stateRoot,
			modulePath: join(stateRoot, "missing-chrome-cache.ts"),
		});
		await expect(client.read("/project/a")).resolves.toBeUndefined();
		await client.dispose();
	});

	it("round-trips cache operations in its worker", async () => {
		const client = createClient();
		try {
			await client.write("/project/a", { modelLabel: "openai/gpt-5.5", thinkingLevel: "high" });
			await expect(client.read("/project/a")).resolves.toEqual({
				modelLabel: "openai/gpt-5.5",
				thinkingLevel: "high",
			});
		} finally {
			await client.dispose();
		}
	});

	it("keeps the caller event loop responsive while worker I/O is delayed", async () => {
		const client = createClient(100);
		try {
			let completed = false;
			const read = client.read("/project/a").then(() => { completed = true; });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(completed).toBe(false);
			await read;
		} finally {
			await client.dispose();
		}
	});
});
