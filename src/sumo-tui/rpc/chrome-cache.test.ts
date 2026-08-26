import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCachedChrome, writeCachedChrome } from "./chrome-cache.js";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "sumocode-chrome-cache-"));
	tempDirectories.push(directory);
	return directory;
}

interface CacheFixture {
	stateRoot: string;
	path: string;
}

function cacheFixture(): CacheFixture {
	const stateRoot = join(temporaryDirectory(), "state");
	return {
		stateRoot,
		path: join(stateRoot, "sumocode", "chrome", "v1", "chrome-cache.json"),
	};
}

describe("chrome cache", () => {
	it("round-trips private cached chrome by cwd", () => {
		const { stateRoot, path } = cacheFixture();
		writeCachedChrome("/project/a", { modelLabel: "openai/gpt-5.5", thinkingLevel: "high" }, { stateRoot, now: () => 10 });

		expect(readCachedChrome("/project/a", { stateRoot })).toEqual({ modelLabel: "openai/gpt-5.5", thinkingLevel: "high" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, byCwd: { "/project/a": { savedAt: 10 } } });
		expect(existsSync(`${path}.lock`)).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("resolves SUMOCODE_STATE_DIR ahead of PI_CODING_AGENT_DIR", () => {
		const directory = temporaryDirectory();
		const stateRoot = join(directory, "custom-state");
		const agentDir = join(directory, "agent");
		const env = { SUMOCODE_STATE_DIR: stateRoot, PI_CODING_AGENT_DIR: agentDir };
		writeCachedChrome("/project/a", { modelLabel: "model" }, { env });

		expect(readCachedChrome("/project/a", { env })).toEqual({ modelLabel: "model" });
		expect(existsSync(join(stateRoot, "sumocode", "chrome", "v1", "chrome-cache.json"))).toBe(true);
		expect(existsSync(join(agentDir, "state", "sumocode", "chrome", "v1", "chrome-cache.json"))).toBe(false);
	});

	it("uses the Pi agent state root when no SumoCode override exists", () => {
		const agentDir = join(temporaryDirectory(), "agent");
		const env = { PI_CODING_AGENT_DIR: agentDir };
		writeCachedChrome("/project/a", { thinkingLevel: "high" }, { env });

		expect(readCachedChrome("/project/a", { env })).toEqual({ thinkingLevel: "high" });
		expect(existsSync(join(agentDir, "state", "sumocode", "chrome", "v1", "chrome-cache.json"))).toBe(true);
	});

	it("returns undefined for missing, corrupt, and wrong-version files", () => {
		const { stateRoot, path } = cacheFixture();
		expect(readCachedChrome("/project/a", { stateRoot })).toBeUndefined();

		writeCachedChrome("/project/a", { modelLabel: "model" }, { stateRoot });
		writeFileSync(path, "not json");
		expect(readCachedChrome("/project/a", { stateRoot })).toBeUndefined();

		writeFileSync(path, JSON.stringify({ version: 2, byCwd: {} }));
		expect(readCachedChrome("/project/a", { stateRoot })).toBeUndefined();
	});

	it("evicts the oldest cwd when the cache reaches 21 entries", () => {
		const { stateRoot, path } = cacheFixture();
		for (let index = 0; index < 21; index += 1) {
			writeCachedChrome(`/project/${index}`, { modelLabel: `model-${index}` }, { stateRoot, now: () => index });
		}

		expect(readCachedChrome("/project/0", { stateRoot })).toBeUndefined();
		expect(readCachedChrome("/project/1", { stateRoot })).toEqual({ modelLabel: "model-1" });
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).byCwd)).toHaveLength(20);
	});

	it("swallows write failures", () => {
		expect(() => writeCachedChrome("/project/a", { modelLabel: "model" }, { stateRoot: "/dev/null" })).not.toThrow();
	});
});
