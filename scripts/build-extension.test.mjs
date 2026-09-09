import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
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
const temporaryDirectories = [];
const isolatedPackageRoots = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
	await Promise.all(isolatedPackageRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generated dist outputs", () => {
	it("are build artifacts: ignored by git and never tracked", () => {
		const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		expect(git("ls-files", "--", "dist")).toBe("");
		for (const path of ["dist/extension/sumocode-extension.bundle.mjs", "dist/extension/.inputs.json", "dist/host/sumo-rpc-host.bundle.mjs"]) {
			expect(git("check-ignore", "--no-index", path)).toBe(path);
		}
	});
});

let isolatedBuild;

// One real build per file: every freshness assertion inspects this artifact.
function buildIsolatedPackage() {
	isolatedBuild ??= buildIsolatedPackageOnce();
	return isolatedBuild;
}

async function buildIsolatedPackageOnce() {
	const packageRoot = await mkdtemp(join(tmpdir(), "sumocode-extension-build-"));
	isolatedPackageRoots.push(packageRoot);
	for (const entry of ["src", "scripts", "package.json", "tsconfig.json"]) {
		await cp(resolve(root, entry), join(packageRoot, entry), { recursive: true });
	}
	await symlink(resolve(root, "node_modules"), join(packageRoot, "node_modules"), "dir");
	execFileSync(process.execPath, ["scripts/build-extension.mjs"], { cwd: packageRoot, stdio: "pipe" });
	const manifest = JSON.parse(await readFile(join(packageRoot, "dist", "extension", ".inputs.json"), "utf8"));
	return { packageRoot, manifest };
}

describe("extension bundle freshness", () => {
	// The repository never carries a bundle; every assertion below inspects an
	// artifact generated into a private package copy by the real build script.
	it("builds a self-verifying bundle whose manifest binds inputs to published outputs", async () => {
		const { packageRoot, manifest } = await buildIsolatedPackage();
		expect(existsSync(join(packageRoot, "dist", "extension", "sumocode-extension.bundle.mjs"))).toBe(true);
		for (const asset of EXTENSION_ASSETS) expect(existsSync(join(packageRoot, "dist", "extension", asset.output))).toBe(true);

		const [inputsFresh, expectedOutputs] = await Promise.all([
			extensionInputManifestIsFresh(packageRoot, manifest),
			extensionOutputsHash(packageRoot),
		]);
		expect(inputsFresh).toBe(true);
		// The output digest is bound into the manifest, not a separate sidecar.
		expect(manifest.outputsHash).toBe(expectedOutputs);
	}, 60_000);

	it("derives inputs from the esbuild graph, not a broad src/ walk", async () => {
		const { manifest } = await buildIsolatedPackage();
		expect(manifest.version).toBe(EXTENSION_INPUT_MANIFEST_VERSION);
		// The extension entry graph must be present; host-only production files
		// that never reach the extension artifact must not be.
		expect(manifest.inputs).toContain("src/extension.ts");
		expect(manifest.inputs).not.toContain("src/sumo-tui/rpc/client.ts");
		expect(manifest.inputs).not.toContain("src/sumo-tui/rpc/host.ts");
		expect(manifest.inputs.some((path) => path.startsWith("src/spike/"))).toBe(false);
		expect(manifest.inputs.some((path) => path.includes("node_modules/"))).toBe(false);
	}, 60_000);

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
