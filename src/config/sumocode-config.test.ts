import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUMOCODE_CONFIG, loadSumoCodeConfig, resolveSumoCodeConfigCandidates } from "./sumocode-config.js";

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

	it("skips malformed config files and validates primaryAgentName", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-config-invalid-"));
		const cwd = join(root, "project");
		const homeDir = join(root, "home");
		mkdirSync(cwd, { recursive: true });
		const [project, projectPi] = resolveSumoCodeConfigCandidates({ cwd, homeDir });
		writeFileSync(project.path, "{");
		writeJson(projectPi.path, { primaryAgentName: "  Zeus  " });

		try {
			expect(loadSumoCodeConfig({ cwd, homeDir })).toMatchObject({ config: { primaryAgentName: "Zeus" }, source: "project-pi" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
