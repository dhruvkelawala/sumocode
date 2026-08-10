import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCachedChrome, writeCachedChrome } from "./chrome-cache.js";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function cachePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "sumocode-chrome-cache-"));
	tempDirectories.push(directory);
	return join(directory, "nested", "chrome-cache.json");
}

describe("chrome cache", () => {
	it("round-trips cached chrome by cwd", () => {
		const path = cachePath();
		writeCachedChrome("/project/a", { modelLabel: "openai/gpt-5.5", thinkingLevel: "high" }, { path, now: () => 10 });

		expect(readCachedChrome("/project/a", { path })).toEqual({ modelLabel: "openai/gpt-5.5", thinkingLevel: "high" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, byCwd: { "/project/a": { savedAt: 10 } } });
	});

	it("returns undefined for missing, corrupt, and wrong-version files", () => {
		const path = cachePath();
		expect(readCachedChrome("/project/a", { path })).toBeUndefined();

		writeCachedChrome("/project/a", { modelLabel: "model" }, { path });
		writeFileSync(path, "not json");
		expect(readCachedChrome("/project/a", { path })).toBeUndefined();

		writeFileSync(path, JSON.stringify({ version: 2, byCwd: {} }));
		expect(readCachedChrome("/project/a", { path })).toBeUndefined();
	});

	it("evicts the oldest cwd when the cache reaches 21 entries", () => {
		const path = cachePath();
		for (let index = 0; index < 21; index += 1) {
			writeCachedChrome(`/project/${index}`, { modelLabel: `model-${index}` }, { path, now: () => index });
		}

		expect(readCachedChrome("/project/0", { path })).toBeUndefined();
		expect(readCachedChrome("/project/1", { path })).toEqual({ modelLabel: "model-1" });
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).byCwd)).toHaveLength(20);
	});

	it("swallows write failures", () => {
		expect(() => writeCachedChrome("/project/a", { modelLabel: "model" }, { path: "/dev/null/chrome-cache.json" })).not.toThrow();
	});
});
