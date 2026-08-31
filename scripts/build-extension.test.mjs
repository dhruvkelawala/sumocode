import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { onlyHarnessScriptPackageDrift } from "./preflight-integration.mjs";
import {
	EXTENSION_ASSETS,
	EXTENSION_INPUT_MANIFEST_VERSION,
	EXTENSION_RECIPE_INPUTS,
	extensionInputFilesFromGraph,
	extensionInputManifestIsFresh,
	extensionInputsHashFromManifest,
	extensionOutputsHash,
	normalizeHashPath,
} from "./lib/extension-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist/extension");
const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function readManifest() {
	return JSON.parse(await readFile(resolve(outDir, ".inputs.json"), "utf8"));
}

describe("extension bundle freshness", () => {
	it("matches the committed bundle to its recorded input graph and copied assets", async () => {
		expect(existsSync(resolve(outDir, "sumocode-extension.bundle.mjs"))).toBe(true);
		for (const asset of EXTENSION_ASSETS) expect(existsSync(resolve(outDir, asset.output))).toBe(true);

		const manifest = await readManifest();
		const manifestPath = resolve(outDir, ".inputs.json");
		const [inputsFresh, expectedOutputs] = await Promise.all([
			extensionInputManifestIsFresh(root, manifest),
			extensionOutputsHash(root),
		]);
		// Harness-only package scripts do not enter emitted extension bytes. The
		// narrow git-backed exception keeps Plan 116 inside its no-dist scope;
		// every other recipe/input change still fails this freshness contract.
		const harnessScriptOnlyDrift = !inputsFresh && await onlyHarnessScriptPackageDrift(root, manifest, manifestPath);
		// The output digest is bound into the manifest, not a separate sidecar.
		if ((!inputsFresh && !harnessScriptOnlyDrift) || manifest.outputsHash !== expectedOutputs) {
			throw new Error("bundle out of date or corrupt — run pnpm build:extension");
		}
	});

	it("derives inputs from the esbuild graph, not a broad src/ walk", async () => {
		const manifest = await readManifest();
		expect(manifest.version).toBe(EXTENSION_INPUT_MANIFEST_VERSION);
		// The extension entry graph must be present; host-only production files
		// that never reach the extension artifact must not be.
		expect(manifest.inputs).toContain("src/extension.ts");
		expect(manifest.inputs).not.toContain("src/sumo-tui/rpc/client.ts");
		expect(manifest.inputs).not.toContain("src/sumo-tui/rpc/host.ts");
		expect(manifest.inputs.some((path) => path.startsWith("src/spike/"))).toBe(false);
		expect(manifest.inputs.some((path) => path.includes("node_modules/"))).toBe(false);
	});

	it("keeps graph project inputs, filters node_modules, and adds recipe + assets", () => {
		const inputs = extensionInputFilesFromGraph(root, [
			"src/extension.ts",
			"src/commands/example.ts",
			"node_modules/@earendil-works/pi-tui/dist/index.js",
		]);
		expect(inputs).toContain("src/extension.ts");
		expect(inputs).toContain("src/commands/example.ts");
		expect(inputs.some((path) => path.includes("node_modules/"))).toBe(false);
		for (const input of EXTENSION_RECIPE_INPUTS) expect(inputs).toContain(input);
		for (const asset of EXTENSION_ASSETS) expect(inputs).toContain(asset.source);
		expect([...inputs].sort().every((value, index) => value === inputs[index])).toBe(true);
	});

	it("invalidates the manifest when a recorded input is deleted", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "sumocode-extension-input-manifest-"));
		temporaryDirectories.push(projectRoot);
		await mkdir(join(projectRoot, "src"));
		await writeFile(join(projectRoot, "src", "extension.ts"), 'import "./dep.js";\n');
		await writeFile(join(projectRoot, "src", "dep.ts"), "export const dep = true;\n");
		const inputs = ["src/dep.ts", "src/extension.ts"];
		const manifest = {
			version: EXTENSION_INPUT_MANIFEST_VERSION,
			inputs,
			hash: await extensionInputsHashFromManifest(projectRoot, inputs),
		};

		await expect(extensionInputManifestIsFresh(projectRoot, manifest)).resolves.toBe(true);
		await unlink(join(projectRoot, "src", "dep.ts"));
		await expect(extensionInputManifestIsFresh(projectRoot, manifest)).resolves.toBe(false);
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
