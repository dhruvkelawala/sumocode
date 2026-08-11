import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_INPUT_MANIFEST_VERSION, hostInputManifestIsFresh, hostInputManifestsMatch, hostInputsHash } from "./lib/host-bundle.mjs";

const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("host bundle input manifest", () => {
	it("rejects a graph or content change across the writing build", () => {
		const before = { version: HOST_INPUT_MANIFEST_VERSION, inputs: ["src/entry.ts"], hash: "before" };
		expect(hostInputManifestsMatch(before, { ...before })).toBe(true);
		expect(hostInputManifestsMatch(before, { ...before, hash: "after" })).toBe(false);
		expect(hostInputManifestsMatch(before, { ...before, inputs: ["src/entry.ts", "src/new.ts"] })).toBe(false);
	});

	it("invalidates a bundle when a recorded production input is deleted", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-host-input-manifest-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "entry.ts"), 'import "./removed.js";\n');
		await writeFile(join(root, "src", "removed.ts"), "export const removed = true;\n");
		const inputs = ["src/entry.ts", "src/removed.ts"];
		const manifest = {
			version: HOST_INPUT_MANIFEST_VERSION,
			inputs,
			hash: await hostInputsHash(root, inputs),
		};

		await expect(hostInputManifestIsFresh(root, manifest)).resolves.toBe(true);
		await unlink(join(root, "src", "removed.ts"));
		await expect(hostInputManifestIsFresh(root, manifest)).resolves.toBe(false);
	});
});
