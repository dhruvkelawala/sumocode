import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "src", "extension.ts");
const bundlePath = join(root, "dist", "extension", "sumocode-extension.bundle.mjs");
const inputsHashPath = join(root, "dist", "extension", ".inputs-hash");
const extensionAssets = [
	"src/assets/sumo-face.ans",
	"src/background-tasks/bounded-terminal-runner.mjs",
];

function extensionInputsHash(): string {
	const files: string[] = [];
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
				files.push(path);
			}
		}
	}
	visit(join(root, "src"));
	files.push(...extensionAssets.map((asset) => resolve(root, asset)));
	files.sort((left, right) => left.localeCompare(right));

	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(relative(root, path));
		hash.update("\\0");
		hash.update(readFileSync(path));
		hash.update("\\0");
	}
	return hash.digest("hex");
}

function hasFreshBundle(): boolean {
	if (!existsSync(bundlePath) || !existsSync(inputsHashPath)) return false;
	try {
		return readFileSync(inputsHashPath, "utf8").trim() === extensionInputsHash();
	} catch {
		return false;
	}
}

function selectedEntry(): string {
	return hasFreshBundle() ? bundlePath : sourcePath;
}

// This dynamic import stays inside Pi's extension-loader jiti context, preserving
// its aliases for peer-only Pi packages and its shared module singletons.
const extensionModule = await import(pathToFileURL(selectedEntry()).href);

export default extensionModule.default;
