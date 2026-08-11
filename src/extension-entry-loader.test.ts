import { describe, expect, it, vi } from "vitest";
import { importExtensionEntry } from "./extension-entry-loader.js";

describe("importExtensionEntry", () => {
	it("falls back to source when a fresh bundle cannot resolve at runtime", async () => {
		const bundleError = new Error("peer import unavailable");
		const importer = vi.fn(async (path: string) => {
			if (path === "/bundle.mjs") throw bundleError;
			return { entry: path };
		});
		const onBundleFailure = vi.fn();

		await expect(importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: true,
			importer,
			onBundleFailure,
		})).resolves.toEqual({ entry: "/source.ts" });
		expect(importer).toHaveBeenCalledTimes(2);
		expect(onBundleFailure).toHaveBeenCalledWith(bundleError);
	});

	it("loads source directly when bundle freshness rejects the artifact", async () => {
		const importer = vi.fn(async (path: string) => ({ entry: path }));
		await importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: false,
			importer,
		});
		expect(importer).toHaveBeenCalledOnce();
		expect(importer).toHaveBeenCalledWith("/source.ts");
	});

	it("propagates source import failures", async () => {
		const importer = vi.fn(async () => { throw new Error("source failed"); });
		await expect(importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: false,
			importer,
		})).rejects.toThrow("source failed");
	});
});
