import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadLovelyWebConfig,
	normalizeLovelyWebPatch,
	resolveLovelyWebConfigPath,
	updateLovelyWebConfigValue,
	writeLovelyWebPatch,
} from "./lovely-web-config.js";

let dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-config-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

describe("Lovely Web config helpers", () => {
	it("normalizes the legacy nested Lovely Web config shape into the flat 0.2 schema", () => {
		expect(normalizeLovelyWebPatch({
			webSearch: { provider: "exa" },
			webFetch: { provider: null },
			webImage: { enabled: false, resize: false, maxSize: 1200 },
			webApiKeys: { exa: "exa-key", firecrawl: "fc-key" },
			unknownFutureKey: true,
		})).toEqual({
			webSearchProvider: "exa",
			webFetchProvider: "disabled",
			webImageEnabled: false,
			webImageResize: false,
			webImageMaxSize: 1200,
			exaApiKey: "exa-key",
			firecrawlApiKey: "fc-key",
			unknownFutureKey: true,
		});
	});

	it("loads user and workspace patches in Lovely Web scope order", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(resolveLovelyWebConfigPath("user", cwd, { PI_CODING_AGENT_DIR: agentDir }), JSON.stringify({ webSearchProvider: "brave", firecrawlApiKey: "user-key" }));
		writeLovelyWebPatch("workspace", cwd, { webSearchProvider: "tavily" }, { PI_CODING_AGENT_DIR: agentDir });

		const state = loadLovelyWebConfig(cwd, { PI_CODING_AGENT_DIR: agentDir });

		expect(state.value.webSearchProvider).toBe("tavily");
		expect(state.value.firecrawlApiKey).toBe("user-key");
		expect(state.userPath).toBe(join(agentDir, "xl0-pi-lovely-web.json"));
		expect(state.workspacePath).toBe(join(cwd, ".pi", "xl0-pi-lovely-web.json"));
	});

	it("updates one key, preserves unknown keys, and deletes blank values", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeLovelyWebPatch("user", cwd, { unknownFutureKey: "keep", firecrawlApiKey: "old" }, { PI_CODING_AGENT_DIR: agentDir });

		const path = updateLovelyWebConfigValue("user", cwd, "webFetchProvider", "firecrawl", { PI_CODING_AGENT_DIR: agentDir });
		updateLovelyWebConfigValue("user", cwd, "firecrawlApiKey", "", { PI_CODING_AGENT_DIR: agentDir });

		const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(written).toEqual({ unknownFutureKey: "keep", webFetchProvider: "firecrawl" });
	});
});
