import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTENSION_ASSETS, extensionInputsHash } from "./lib/extension-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist/extension");

async function readInputsHash() {
	return (await readFile(resolve(outDir, ".inputs-hash"), "utf8")).trim();
}

describe("extension bundle freshness", () => {
	it("matches the committed bundle to every source and copied asset input", async () => {
		expect(existsSync(resolve(outDir, "sumocode-extension.bundle.mjs"))).toBe(true);
		for (const asset of EXTENSION_ASSETS) expect(existsSync(resolve(outDir, asset.output))).toBe(true);

		const actual = await readInputsHash();
		const expected = await extensionInputsHash(root);
		if (actual !== expected) throw new Error("bundle out of date — run pnpm build:extension");
	});
});
