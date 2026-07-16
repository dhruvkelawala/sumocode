import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGlobalSumoCodeConfigPath } from "../config/sumocode-config.js";
import { getActiveTheme, resetThemeRegistryForTests } from "./registry.js";
import { applyStartupTheme, resolveStartupThemeName } from "./startup.js";

function writeGlobalConfig(homeDir: string, value: unknown): void {
	const path = resolveGlobalSumoCodeConfigPath(homeDir, {});
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

describe("resolveStartupThemeName", () => {
	it("resolves to the configured theme when it names a known registry entry", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-startup-theme-known-"));
		const homeDir = join(root, "home");
		writeGlobalConfig(homeDir, { themeName: "amber-crt" });

		try {
			expect(resolveStartupThemeName({ cwd: root, homeDir, env: {} })).toBe("amber-crt");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to obsidian when the configured theme is unknown", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-startup-theme-unknown-"));
		const homeDir = join(root, "home");
		writeGlobalConfig(homeDir, { themeName: "not-a-real-theme" });

		try {
			expect(resolveStartupThemeName({ cwd: root, homeDir, env: {} })).toBe("obsidian");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to obsidian when no theme is configured", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-startup-theme-unconfigured-"));
		const homeDir = join(root, "home");

		try {
			expect(resolveStartupThemeName({ cwd: root, homeDir, env: {} })).toBe("obsidian");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("applyStartupTheme", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("applies the resolved theme to the shared registry", () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-startup-theme-apply-"));
		const homeDir = join(root, "home");
		writeGlobalConfig(homeDir, { themeName: "amber-crt" });

		try {
			const themeName = applyStartupTheme({ cwd: root, homeDir, env: {} });
			expect(themeName).toBe("amber-crt");
			expect(getActiveTheme().name).toBe("amber-crt");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
