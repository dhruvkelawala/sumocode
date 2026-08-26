import type { LovelyWebConfigPatch } from "./lovely-web-config.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function privateConfigDir(): string {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
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
		const configDir = tempDir();
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: configDir };
		writeFileSync(resolveLovelyWebConfigPath("user", cwd, env), JSON.stringify({ webSearchProvider: "brave", firecrawlApiKey: "user-key" }));
		writeLovelyWebPatch("workspace", cwd, { webSearchProvider: "tavily" }, env);

		const state = loadLovelyWebConfig(cwd, env);

		expect(state.value.webSearchProvider).toBe("tavily");
		expect(state.value.firecrawlApiKey).toBe("user-key");
		expect(state.userPath).toBe(join(agentDir, "xl0-pi-lovely-web.json"));
		expect(state.workspacePath).toBe(join(cwd, ".pi", "xl0-pi-lovely-web.json"));
	});

	it("updates one key, preserves unknown keys, and deletes blank values", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const configDir = privateConfigDir();
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: configDir };
		writeLovelyWebPatch("user", cwd, { unknownFutureKey: "keep", firecrawlApiKey: "old" }, env);

		const path = updateLovelyWebConfigValue("user", cwd, "webFetchProvider", "firecrawl", env);
		updateLovelyWebConfigValue("user", cwd, "firecrawlApiKey", "", env);

		// SAFETY: the file was just written by updateLovelyWebConfigValue and is
		// only compared structurally via toEqual below.
		const written = JSON.parse(await readFile(path, "utf8")) as LovelyWebConfigPatch;
		expect(written).toEqual({ unknownFutureKey: "keep", webFetchProvider: "firecrawl" });
	});

	it("creates and preserves a private managed user-config symlink with mode 0600", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const configDir = privateConfigDir();
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: configDir };
		const target = writeLovelyWebPatch("user", cwd, { firecrawlApiKey: "secret" }, env);
		const source = join(configDir, "xl0-pi-lovely-web.json");

		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await readFile(source, "utf8"))).toEqual({ firecrawlApiKey: "secret" });
		expect(statSync(source).mode & 0o777).toBe(0o600);

		writeLovelyWebPatch("user", cwd, {}, env);
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await readFile(source, "utf8"))).toEqual({});
	});

	it("loads an existing private source before its agent-dir symlink is created", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const configDir = privateConfigDir();
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: configDir };
		writeFileSync(join(configDir, "xl0-pi-lovely-web.json"), JSON.stringify({ exaApiKey: "private-key" }), { mode: 0o600 });

		expect(loadLovelyWebConfig(cwd, env).value.exaApiKey).toBe("private-key");
		updateLovelyWebConfigValue("user", cwd, "webSearchProvider", "exa", env);
		expect(lstatSync(join(agentDir, "xl0-pi-lovely-web.json")).isSymbolicLink()).toBe(true);
		expect(loadLovelyWebConfig(cwd, env).value.exaApiKey).toBe("private-key");
	});

	it("replaces a noncanonical user-config symlink without writing through it", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const configDir = privateConfigDir();
		const externalDir = tempDir();
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: configDir };
		const target = join(agentDir, "xl0-pi-lovely-web.json");
		const external = join(externalDir, "outside.json");
		const canonical = join(configDir, "xl0-pi-lovely-web.json");
		writeFileSync(external, JSON.stringify({ exaApiKey: "outside-key" }));
		symlinkSync(external, target);

		writeLovelyWebPatch("user", cwd, { exaApiKey: "private-key" }, env);

		expect(JSON.parse(await readFile(external, "utf8"))).toEqual({ exaApiKey: "outside-key" });
		expect(readlinkSync(target)).toBe(canonical);
		expect(JSON.parse(await readFile(canonical, "utf8"))).toEqual({ exaApiKey: "private-key" });
	});

	it("refuses to create a non-repository private config root", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const configDir = join(tempDir(), "not-bootstrapped");
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: configDir };

		expect(() => writeLovelyWebPatch("user", cwd, { exaApiKey: "secret" }, env)).toThrow(/bootstrap.*private config repository/i);
		expect(existsSync(configDir)).toBe(false);
	});

	it("prefers an existing private source over a stale unmanaged target", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const configDir = privateConfigDir();
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: configDir };
		const target = join(agentDir, "xl0-pi-lovely-web.json");
		const source = join(configDir, "xl0-pi-lovely-web.json");
		writeFileSync(target, JSON.stringify({ exaApiKey: "stale-key" }));
		writeFileSync(source, JSON.stringify({ exaApiKey: "private-key", webSearchProvider: "exa" }), { mode: 0o600 });

		expect(loadLovelyWebConfig(cwd, env).value.exaApiKey).toBe("private-key");
		updateLovelyWebConfigValue("user", cwd, "webFetchProvider", "exa", env);
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await readFile(source, "utf8"))).toMatchObject({ exaApiKey: "private-key", webSearchProvider: "exa", webFetchProvider: "exa" });
	});

	it("strips API-key fields from workspace config and writes it with mode 0600", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const env = { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_CONFIG_DIR: tempDir() };
		const path = writeLovelyWebPatch("workspace", cwd, { webSearchProvider: "exa", exaApiKey: "must-not-land" }, env);

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ webSearchProvider: "exa" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});
