import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importExtensionEntry } from "./extension-entry-loader.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "src", "extension.ts");
const bundlePath = join(root, "dist", "extension", "sumocode-extension.bundle.mjs");
const inputsHashPath = join(root, "dist", "extension", ".inputs-hash");
const outputsHashPath = join(root, "dist", "extension", ".outputs-hash");
const extensionInputs = [
	"src/assets/sumo-face.ans",
	"src/background-tasks/bounded-terminal-runner.mjs",
	"scripts/build-extension.mjs",
	"scripts/lib/extension-bundle.mjs",
	"tsconfig.json",
];
const extensionOutputs = [
	"sumocode-extension.bundle.mjs",
	"sumocode-extension.bundle.mjs.map",
	"assets/sumo-face.ans",
	"bounded-terminal-runner.mjs",
];

function normalizeHashPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function contentHash(base: string, files: readonly string[]): string {
	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(normalizeHashPath(relative(base, path)));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

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
	files.push(...extensionInputs.map((input) => resolve(root, input)));
	files.sort((left, right) => {
		const leftPath = normalizeHashPath(relative(root, left));
		const rightPath = normalizeHashPath(relative(root, right));
		return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
	});

	return contentHash(root, files);
}

function extensionOutputsHash(): string {
	const outDir = dirname(bundlePath);
	return contentHash(outDir, extensionOutputs.map((output) => resolve(outDir, output)));
}

function hasFreshBundle(): boolean {
	if (!existsSync(bundlePath) || !existsSync(inputsHashPath) || !existsSync(outputsHashPath)) return false;
	try {
		return readFileSync(inputsHashPath, "utf8").trim() === extensionInputsHash()
			&& readFileSync(outputsHashPath, "utf8").trim() === extensionOutputsHash();
	} catch {
		return false;
	}
}

// This dynamic import stays inside Pi's extension-loader jiti context, preserving
// its aliases for peer-only Pi packages and its shared module singletons. A
// content-fresh bundle can still fail native resolution of external peers in a
// particular installation, so import-time failure falls back to source too.
const extensionModule = await importExtensionEntry({
	bundlePath,
	sourcePath,
	useBundle: process.env.SUMOCODE_EXTENSION_BUNDLE !== "0" && hasFreshBundle(),
	importer: (path) => import(pathToFileURL(path).href),
	onBundleFailure: () => {
		console.warn("[sumocode] extension bundle failed to import — using source");
	},
});

export default extensionModule.default;
