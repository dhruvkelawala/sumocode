import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUMOCODE_CONFIG, loadSumoCodeConfig, resolveGlobalSumoCodeConfigPath, resolveSumoCodeConfigCandidates, saveSumoCodeConfigPatch } from "./sumocode-config.js";

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function removeIfExists(path: string): void {
	if (existsSync(path)) unlinkSync(path);
}

describe("sumocode-config", () => {
	it("resolves config in deterministic project, project .pi, global, default order", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });

		const [project, projectPi, global] = resolveSumoCodeConfigCandidates({ cwd, homeDir });
		writeJson(global.path, { primaryAgentName: "Global" });
		writeJson(projectPi.path, { primaryAgentName: "ProjectPi" });
		writeJson(project.path, { primaryAgentName: "Project" });

		try {
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({ config: { primaryAgentName: "Project" }, source: "project" });

			removeIfExists(project.path);
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({ config: { primaryAgentName: "ProjectPi" }, source: "project-pi" });

			removeIfExists(projectPi.path);
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({ config: { primaryAgentName: "Global" }, source: "global" });

			removeIfExists(global.path);
			expect(loadSumoCodeConfig({ cwd, homeDir })).toEqual({ config: DEFAULT_SUMOCODE_CONFIG, source: "defaults" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips malformed config files and trims optional themeName", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-invalid-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });
		const [project, projectPi] = resolveSumoCodeConfigCandidates({ cwd, homeDir });
		writeFileSync(project.path, "{");
		writeJson(projectPi.path, { primaryAgentName: "  Zeus  ", themeName: "  Obsidian  " });

		try {
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({ config: { primaryAgentName: "Zeus", themeName: "obsidian" }, source: "project-pi" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts theme-only config files and falls back to default agent name", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-theme-only-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });
		const [project] = resolveSumoCodeConfigCandidates({ cwd, homeDir });
		writeJson(project.path, { themeName: "cathedral" });

		try {
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({ config: { primaryAgentName: "SUMO", themeName: "cathedral" }, source: "project" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fills missing primaryAgentName from lower-priority configs", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-theme-merge-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });
		const [project, , global] = resolveSumoCodeConfigCandidates({ cwd, homeDir });
		writeJson(project.path, { themeName: "cathedral" });
		writeJson(global.path, { primaryAgentName: "Zeus", themeName: "obsidian" });

		try {
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({
				config: { primaryAgentName: "Zeus", themeName: "cathedral" },
				source: "project",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips config files without recognized SumoCode keys", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-unrecognized-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });
		const [project, projectPi] = resolveSumoCodeConfigCandidates({ cwd, homeDir });
		writeJson(project.path, { otherToolConfig: true });
		writeJson(projectPi.path, { primaryAgentName: "Zeus" });

		try {
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({ config: { primaryAgentName: "Zeus" }, source: "project-pi" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips unreadable config files while loading", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-unreadable-load-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });
		const [, projectPi] = resolveSumoCodeConfigCandidates({ cwd, homeDir });

		try {
			expect(loadSumoCodeConfig({
				cwd,
				homeDir,
				readFile: (path) => {
					if (path.endsWith(".sumocode.json")) throw new Error("EACCES");
					if (path === projectPi.path) return JSON.stringify({ primaryAgentName: "Zeus", themeName: "cathedral" });
					return undefined;
				},
			})).toMatchObject({ config: { primaryAgentName: "Zeus", themeName: "cathedral" }, source: "project-pi" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fills missing themeName from lower-priority configs", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-merge-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });
		const [project, , global] = resolveSumoCodeConfigCandidates({ cwd, homeDir });
		writeJson(project.path, { primaryAgentName: "Project" });
		writeJson(global.path, { primaryAgentName: "Global", themeName: "cathedral" });

		try {
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({
				config: { primaryAgentName: "Project", themeName: "cathedral" },
				source: "project",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists themeName to the synced global config while preserving existing keys", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-save-"));
		const homeDir = join(root, "home");
		const globalPath = resolveGlobalSumoCodeConfigPath(homeDir);
		writeJson(globalPath, { primaryAgentName: "Zeus", extra: true });

		try {
			expect(saveSumoCodeConfigPatch({ themeName: "obsidian" }, { homeDir })).toMatchObject({ success: true, path: globalPath });
			expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ primaryAgentName: "Zeus", extra: true, themeName: "obsidian" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite malformed global config", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-malformed-save-"));
		const homeDir = join(root, "home");
		const globalPath = resolveGlobalSumoCodeConfigPath(homeDir);
		mkdirSync(dirname(globalPath), { recursive: true });
		writeFileSync(globalPath, "{");

		try {
			expect(saveSumoCodeConfigPatch({ themeName: "obsidian" }, { homeDir })).toMatchObject({ success: false, path: globalPath });
			expect(readFileSync(globalPath, "utf8")).toBe("{");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a save error when the existing global config cannot be read", () => {
		expect(saveSumoCodeConfigPatch({ themeName: "obsidian" }, {
			homeDir: "/home/user",
			readFile: () => {
				throw new Error("EACCES");
			},
		})).toMatchObject({ success: false, error: "EACCES" });
	});
});
