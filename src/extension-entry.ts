import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "src", "extension.ts");
const bundlePath = join(root, "dist", "extension", "sumocode-extension.bundle.mjs");

function newestSourceMtime(): number {
	let newest = 0;
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
				newest = Math.max(newest, statSync(path).mtimeMs);
			}
		}
	}
	try {
		visit(join(root, "src"));
	} catch {
		return Number.POSITIVE_INFINITY;
	}
	return newest;
}

function selectedEntry(): string {
	try {
		if (existsSync(bundlePath) && statSync(bundlePath).mtimeMs >= newestSourceMtime()) return bundlePath;
	} catch {
		// Fall through to the source entry when the optional bundle is unavailable.
	}
	return sourcePath;
}

// This dynamic import stays inside Pi's extension-loader jiti context, preserving
// its aliases for peer-only Pi packages and its shared module singletons.
const extensionModule = await import(pathToFileURL(selectedEntry()).href);

export default extensionModule.default;
