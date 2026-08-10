import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const EXTENSION_ASSETS = [
	{ source: "src/assets/sumo-face.ans", output: "assets/sumo-face.ans" },
	{ source: "src/background-tasks/bounded-terminal-runner.mjs", output: "bounded-terminal-runner.mjs" },
];

async function sourceTypeScriptFiles(root) {
	const files = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
		}
	}
	await visit(resolve(root, "src"));
	return files;
}

export async function extensionInputFiles(root) {
	const sourceFiles = await sourceTypeScriptFiles(root);
	const assetFiles = EXTENSION_ASSETS.map(({ source }) => resolve(root, source));
	return [...sourceFiles, ...assetFiles].sort((left, right) => left.localeCompare(right));
}

export async function extensionInputsHash(root) {
	const hash = createHash("sha256");
	for (const path of await extensionInputFiles(root)) {
		hash.update(relative(root, path));
		hash.update("\0");
		hash.update(await readFile(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}
