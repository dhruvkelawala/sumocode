import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTENSION_ASSETS, EXTENSION_RECIPE_INPUTS, extensionInputFiles, extensionInputsHash, extensionOutputsHash, normalizeHashPath } from "./lib/extension-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist/extension");

async function readHash(name) {
	return (await readFile(resolve(outDir, name), "utf8")).trim();
}

describe("extension bundle freshness", () => {
	it("matches the committed bundle to every source and copied asset input", async () => {
		expect(existsSync(resolve(outDir, "sumocode-extension.bundle.mjs"))).toBe(true);
		for (const asset of EXTENSION_ASSETS) expect(existsSync(resolve(outDir, asset.output))).toBe(true);

		const [actualInputs, expectedInputs, actualOutputs, expectedOutputs] = await Promise.all([
			readHash(".inputs-hash"),
			extensionInputsHash(root),
			readHash(".outputs-hash"),
			extensionOutputsHash(root),
		]);
		if (actualInputs !== expectedInputs || actualOutputs !== expectedOutputs) {
			throw new Error("bundle out of date or corrupt — run pnpm build:extension");
		}
	});

	it("excludes throwaway spike sources from runtime freshness", async () => {
		const inputs = (await extensionInputFiles(root)).map((path) => normalizeHashPath(relative(root, path)));
		expect(inputs.some((path) => path.startsWith("src/spike/"))).toBe(false);
	});

	it("hashes the shipped manifest with an exact bundler version", async () => {
		const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
		expect(EXTENSION_RECIPE_INPUTS).toContain("package.json");
		expect(EXTENSION_RECIPE_INPUTS).not.toContain("pnpm-lock.yaml");
		expect(manifest.devDependencies?.esbuild).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("normalizes Windows separators in portable hash paths", () => {
		expect(normalizeHashPath("src\\nested\\extension.ts")).toBe("src/nested/extension.ts");
	});
});
