import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RPC_IMAGE_BYTES, MAX_RPC_IMAGE_TOTAL_BYTES, loadRpcImages } from "./image-content.js";

const roots: string[] = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const require = createRequire(import.meta.url);
type PngInstance = { readonly data: Buffer };
type PngCtor = (new (options: { width: number; height: number }) => PngInstance) & { readonly sync: { write(png: PngInstance): Buffer } };
// SAFETY: pngjs has no declarations; this is the same constructor/data/sync.write subset used by the visual parity tests.
const { PNG: PngImage } = require("pngjs") as { PNG: PngCtor };

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-rpc-image-"));
	roots.push(path);
	return path;
}

function screenshotPng(): Buffer {
	const screenshot = new PngImage({ width: 2560, height: 1600 });
	let noise = 0x12345678;
	for (let index = 0; index < screenshot.data.length; index += 4) {
		noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5;
		screenshot.data[index] = noise;
		screenshot.data[index + 1] = noise >>> 8;
		screenshot.data[index + 2] = noise >>> 16;
		screenshot.data[index + 3] = 255;
	}
	return PngImage.sync.write(screenshot);
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

	it("waits briefly for a macOS promised screenshot file to materialize", async () => {
		const cwd = root();
		const path = join(cwd, "Screenshot 2026-09-16 at 15.48.45.png");
		const materialized = new Promise<void>((resolve) => {
			setTimeout(() => {
				writeFileSync(path, PNG);
				resolve();
			}, 25);
		});

		await expect(loadRpcImages([{ token: "[Image 1]", path }], { cwd })).resolves.toEqual([
			{ type: "image", mimeType: "image/png", data: PNG.toString("base64") },
		]);
		await materialized;
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

	it("resizes a macOS screenshot-sized PNG before applying the RPC payload limit", async () => {
		const cwd = root();
		const source = screenshotPng();
		expect(source.byteLength).toBeGreaterThan(MAX_RPC_IMAGE_BYTES);
		writeFileSync(join(cwd, "Screenshot 2026-03-29 at 22.54.26.png"), source);

		const [image] = await loadRpcImages([{ token: "[Image 1]", path: "./Screenshot 2026-03-29 at 22.54.26.png" }], { cwd });

		expect(["image/png", "image/jpeg"]).toContain(image?.mimeType);
		expect(Buffer.byteLength(image?.data ?? "", "base64")).toBeLessThanOrEqual(MAX_RPC_IMAGE_BYTES);
	}, 15_000);

	it("rejects oversized image data that cannot be decoded for resizing", async () => {
		const cwd = root();
		const malformed = Buffer.alloc(MAX_RPC_IMAGE_BYTES + 1);
		PNG.copy(malformed);
		writeFileSync(join(cwd, "malformed.png"), malformed);

		await expect(loadRpcImages([{ token: "[Image 1]", path: "./malformed.png" }], { cwd })).rejects.toThrow("could not be resized");
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

	it("applies the aggregate limit to resized image bytes", async () => {
		const cwd = root();
		const source = screenshotPng();
		writeFileSync(join(cwd, "one.png"), source);
		writeFileSync(join(cwd, "two.png"), source);

		await expect(loadRpcImages([
			{ token: "[Image 1]", path: "./one.png" },
			{ token: "[Image 2]", path: "./two.png" },
		], { cwd })).rejects.toThrow(`images exceed ${MAX_RPC_IMAGE_TOTAL_BYTES} byte total limit`);
	}, 15_000);

	it("rejects multiple individually valid images that cross the aggregate limit", async () => {
		const cwd = root();
		const large = Buffer.alloc(Math.floor(MAX_RPC_IMAGE_TOTAL_BYTES / 2) + 1);
		PNG.copy(large);
		writeFileSync(join(cwd, "one.png"), large);
		writeFileSync(join(cwd, "two.png"), large);

		await expect(loadRpcImages([
			{ token: "[Image 1]", path: "./one.png" },
			{ token: "[Image 2]", path: "./two.png" },
		], { cwd })).rejects.toThrow(`images exceed ${MAX_RPC_IMAGE_TOTAL_BYTES} byte total limit`);
	});

	it("rejects an oversized image before reading it", async () => {
		const cwd = root();
		const path = join(cwd, "huge.png");
		writeFileSync(path, PNG);

		await expect(loadRpcImages([{ token: "[Image 1]", path }], { cwd, maxSourceBytes: PNG.length - 1 })).rejects.toThrow(`exceeds ${PNG.length - 1} byte limit`);
	});

	it("keeps conservative per-image and aggregate limits below the RPC frame ceiling", () => {
		expect(MAX_RPC_IMAGE_BYTES).toBe(3 * 1024 * 1024);
		expect(MAX_RPC_IMAGE_TOTAL_BYTES).toBe(5 * 1024 * 1024);
	});
});
