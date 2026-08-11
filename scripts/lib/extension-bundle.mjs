import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const EXTENSION_ASSETS = [
	{ source: "src/assets/sumo-face.ans", output: "assets/sumo-face.ans" },
	{ source: "src/background-tasks/bounded-terminal-runner.mjs", output: "bounded-terminal-runner.mjs" },
];

export const EXTENSION_RUNTIME_OUTPUTS = [
	"sumocode-extension.bundle.mjs",
	"sumocode-extension.bundle.mjs.map",
	...EXTENSION_ASSETS.map(({ output }) => output),
];

export const EXTENSION_RECIPE_INPUTS = [
	"scripts/build-extension.mjs",
	"scripts/lib/extension-bundle.mjs",
	"tsconfig.json",
	// package.json ships in npm/pnpm tarballs and pins the exact esbuild version.
	"package.json",
];

export function normalizeHashPath(path) {
	return path.replaceAll("\\", "/");
}

async function sourceTypeScriptFiles(root) {
	const files = [];
	const sourceRoot = resolve(root, "src");
	const spikeRoot = resolve(sourceRoot, "spike");
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (path === spikeRoot) continue;
				await visit(path);
				continue;
			}
			if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
		}
	}
	await visit(sourceRoot);
	return files;
}

export async function extensionInputFiles(root) {
	const sourceFiles = await sourceTypeScriptFiles(root);
	const assetFiles = EXTENSION_ASSETS.map(({ source }) => resolve(root, source));
	const recipeFiles = EXTENSION_RECIPE_INPUTS.map((input) => resolve(root, input));
	return [...sourceFiles, ...assetFiles, ...recipeFiles].sort((left, right) => {
		const leftPath = normalizeHashPath(relative(root, left));
		const rightPath = normalizeHashPath(relative(root, right));
		return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
	});
}

async function contentHash(base, files) {
	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(normalizeHashPath(relative(base, path)));
		hash.update("\0");
		hash.update(await readFile(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function extensionInputsHash(root) {
	return contentHash(root, await extensionInputFiles(root));
}

export async function extensionOutputsHash(root) {
	const outDir = resolve(root, "dist/extension");
	return contentHash(outDir, EXTENSION_RUNTIME_OUTPUTS.map((output) => resolve(outDir, output)));
}
