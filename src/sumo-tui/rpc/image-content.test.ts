import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RPC_IMAGE_BYTES, MAX_RPC_IMAGE_TOTAL_BYTES, loadRpcImages } from "./image-content.js";

const roots: string[] = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-rpc-image-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("loadRpcImages", () => {
	it("resolves a path with spaces and emits Pi ImageContent", async () => {
		const cwd = root();
		writeFileSync(join(cwd, "image one.png"), PNG);

		await expect(loadRpcImages([{ token: "[Image 1]", path: "./image one.png" }], { cwd })).resolves.toEqual([
			{ type: "image", mimeType: "image/png", data: PNG.toString("base64") },
		]);
	});

	it.each([
		["missing.png", "not found"],
		["folder.png", "regular file"],
		["spoofed.png", "does not contain a supported image"],
	] as const)("rejects %s without exposing file contents", async (name, reason) => {
		const cwd = root();
		if (name === "folder.png") mkdirSync(join(cwd, name));
		if (name === "spoofed.png") writeFileSync(join(cwd, name), "secret-image-payload");

		await expect(loadRpcImages([{ token: "[Image 1]", path: `./${name}` }], { cwd })).rejects.toThrow(reason);
		await expect(loadRpcImages([{ token: "[Image 1]", path: `./${name}` }], { cwd })).rejects.not.toThrow("secret-image-payload");
	});

	it("loads multiple images while keeping the aggregate below the RPC frame ceiling", async () => {
		const cwd = root();
		writeFileSync(join(cwd, "one.png"), PNG);
		writeFileSync(join(cwd, "two.png"), PNG);

		const images = await loadRpcImages([
			{ token: "[Image 1]", path: "./one.png" },
			{ token: "[Image 2]", path: "./two.png" },
		], { cwd });
		expect(images).toHaveLength(2);
		expect(images.map((entry) => entry.data)).toEqual([PNG.toString("base64"), PNG.toString("base64")]);
	});

	it("rejects an oversized image before reading it", async () => {
		const cwd = root();
		const path = join(cwd, "huge.png");
		writeFileSync(path, PNG);

		await expect(loadRpcImages([{ token: "[Image 1]", path }], { cwd, maxBytes: PNG.length - 1 })).rejects.toThrow(`exceeds ${PNG.length - 1} byte limit`);
	});

	it("keeps conservative per-image and aggregate limits below the RPC frame ceiling", () => {
		expect(MAX_RPC_IMAGE_BYTES).toBe(3 * 1024 * 1024);
		expect(MAX_RPC_IMAGE_TOTAL_BYTES).toBe(5 * 1024 * 1024);
	});
});
