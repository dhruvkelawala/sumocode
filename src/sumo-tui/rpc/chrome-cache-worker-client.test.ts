import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChromeCacheWorkerClient } from "./chrome-cache-worker-client.js";

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
