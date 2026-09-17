import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RPC_IMAGE_BYTES, MAX_RPC_IMAGE_TOTAL_BYTES, loadRpcImages } from "./image-content.js";

const roots: string[] = [];
const require = createRequire(import.meta.url);
type PngInstance = { readonly data: Buffer };
type PngCtor = (new (options: { width: number; height: number }) => PngInstance) & { readonly sync: { write(png: PngInstance): Buffer } };
// SAFETY: pngjs has no declarations; this is the same constructor/data/sync.write subset used by the visual parity tests.
const { PNG: PngImage } = require("pngjs") as { PNG: PngCtor };
const PNG = PngImage.sync.write(new PngImage({ width: 1, height: 1 }));

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-rpc-image-"));
	roots.push(path);
	return path;
}

function screenshotPng(width = 2560, height = 1600): Buffer {
	const screenshot = new PngImage({ width, height });
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

		try {
			await expect(loadRpcImages([{ token: "[Image 1]", path }], { cwd })).resolves.toEqual([
				{ type: "image", mimeType: "image/png", data: PNG.toString("base64") },
			]);
		} finally {
			await materialized;
		}
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

	it.each([
		[2400, 1200, 2000, 1000],
		[1200, 2400, 1000, 2000],
	])("bounds a %i × %i screenshot even below the byte limit", async (width, height, expectedWidth, expectedHeight) => {
		const cwd = root();
		const screenshot = new PngImage({ width, height });
		screenshot.data.fill(255);
		const source = PngImage.sync.write(screenshot);
		expect(source.byteLength).toBeLessThan(MAX_RPC_IMAGE_BYTES);
		writeFileSync(join(cwd, "compressed.png"), source);

		const [image] = await loadRpcImages([{ token: "[Image 1]", path: "./compressed.png" }], { cwd });

		expect(getImageDimensions(image!.data, image!.mimeType)).toEqual({ widthPx: expectedWidth, heightPx: expectedHeight });
		expect(Buffer.byteLength(image!.data, "base64")).toBeLessThanOrEqual(MAX_RPC_IMAGE_BYTES);
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

	it.each([16, MAX_RPC_IMAGE_BYTES + 1])("rejects undecodable image data of %i bytes", async (size) => {
		const cwd = root();
		const malformed = Buffer.alloc(size);
		PNG.subarray(0, 16).copy(malformed);
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
		const large = screenshotPng(1000, 850);
		expect(large.byteLength).toBeGreaterThan(MAX_RPC_IMAGE_TOTAL_BYTES / 2);
		expect(large.byteLength).toBeLessThan(MAX_RPC_IMAGE_BYTES);
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
