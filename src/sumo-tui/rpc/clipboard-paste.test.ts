import { readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLikelyClipboardImagePath } from "../../cathedral/editor-draft-state.js";
import { findClipboardImageModulePath, pasteClipboardImageToTempFile, resetClipboardImageLoaderForTests } from "./clipboard-paste.js";

const written: string[] = [];

afterEach(() => {
	resetClipboardImageLoaderForTests();
	for (const path of written.splice(0)) rmSync(path, { force: true });
});

describe("pasteClipboardImageToTempFile", () => {
	it("writes the clipboard image to a pi-clipboard-* temp file that the editor collapses", async () => {
		const path = await pasteClipboardImageToTempFile({
			readClipboardImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
			extensionForImageMimeType: () => "png",
		});

		expect(path).not.toBeNull();
		written.push(path!);
		expect(basename(path!)).toMatch(/^pi-clipboard-[\w-]+\.png$/);
		expect([...readFileSync(path!)]).toEqual([1, 2, 3]);
		// The whole point of the naming: CathedralEditor collapses this path
		// into an [Image N] token via isLikelyClipboardImagePath.
		expect(isLikelyClipboardImagePath(path!)).toBe(true);
	});

	it("returns null when the clipboard has no image", async () => {
		const path = await pasteClipboardImageToTempFile({
			readClipboardImage: async () => null,
			extensionForImageMimeType: () => null,
		});
		expect(path).toBeNull();
	});

	it("returns null when no reader is available", async () => {
		expect(await pasteClipboardImageToTempFile(null)).toBeNull();
	});

	it("survives a throwing reader without crashing the host", async () => {
		const path = await pasteClipboardImageToTempFile({
			readClipboardImage: async () => {
				throw new Error("no clipboard access");
			},
			extensionForImageMimeType: () => null,
		});
		expect(path).toBeNull();
	});

	it("deep-imports pi's real clipboard util (loader resolves in this repo)", async () => {
		// Not asserting on clipboard CONTENTS (host-dependent) — only that the
		// filesystem walk finds the module so Ctrl+V isn't silently dead. If pi
		// relocates dist/utils/clipboard-image.js this fails loudly here
		// instead of degrading in production.
		const modulePath = findClipboardImageModulePath();
		expect(modulePath).not.toBeNull();
		const { pathToFileURL } = await import("node:url");
		const mod = await import(pathToFileURL(modulePath!).href);
		expect(typeof mod.readClipboardImage).toBe("function");
		expect(typeof mod.extensionForImageMimeType).toBe("function");
	});

	it("findClipboardImageModulePath returns null when nothing is found", () => {
		expect(findClipboardImageModulePath(["/nonexistent-root-dir"])).toBeNull();
	});
});
