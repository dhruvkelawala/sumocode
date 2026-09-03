import { describe, expect, it, vi } from "vitest";
import { importExtensionEntry, sourceExtensionFile } from "./extension-entry-loader.js";

describe("sourceExtensionFile", () => {
	it("uses the source-only entry only for launcher-owned RPC children", () => {
		expect(sourceExtensionFile(true, true)).toBe("rpc-child-extension.ts");
		expect(sourceExtensionFile(true, false)).toBe("extension.ts");
		expect(sourceExtensionFile(false, true)).toBe("extension.ts");
	});
});

describe("importExtensionEntry", () => {
	it("falls back through the dedicated source importer when a fresh bundle cannot resolve", async () => {
		const bundleError = new Error("peer import unavailable");
		const bundleImporter = vi.fn(async () => { throw bundleError; });
		const sourceImporter = vi.fn(async (path: string) => ({ entry: path }));
		const onBundleFailure = vi.fn();

		await expect(importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: true,
			bundleImporter,
			sourceImporter,
			onBundleFailure,
		})).resolves.toEqual({ entry: "/source.ts" });
		expect(bundleImporter).toHaveBeenCalledOnce();
		expect(bundleImporter).toHaveBeenCalledWith("/bundle.mjs");
		expect(sourceImporter).toHaveBeenCalledOnce();
		expect(sourceImporter).toHaveBeenCalledWith("/source.ts");
		expect(onBundleFailure).toHaveBeenCalledWith(bundleError);
	});

	it("falls back to source when revalidation fails after a successful bundle import", async () => {
		const bundleImporter = vi.fn(async (path: string) => ({ entry: path }));
		const sourceImporter = vi.fn(async (path: string) => ({ entry: path }));
		const onBundleFailure = vi.fn();

		await expect(importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: true,
			bundleImporter,
			sourceImporter,
			revalidate: () => false,
			onBundleFailure,
		})).resolves.toEqual({ entry: "/source.ts" });
		expect(bundleImporter).toHaveBeenCalledOnce();
		expect(sourceImporter).toHaveBeenCalledWith("/source.ts");
		expect(onBundleFailure).toHaveBeenCalledOnce();
	});

	it("accepts the bundle when revalidation still passes after import", async () => {
		const bundleImporter = vi.fn(async (path: string) => ({ entry: path }));
		const sourceImporter = vi.fn(async (path: string) => ({ entry: path }));
		await expect(importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: true,
			bundleImporter,
			sourceImporter,
			revalidate: () => true,
		})).resolves.toEqual({ entry: "/bundle.mjs" });
		expect(sourceImporter).not.toHaveBeenCalled();
	});

	it("loads source directly without invoking the bundle importer", async () => {
		const bundleImporter = vi.fn(async (path: string) => ({ entry: path }));
		const sourceImporter = vi.fn(async (path: string) => ({ entry: path }));
		await importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: false,
			bundleImporter,
			sourceImporter,
		});
		expect(bundleImporter).not.toHaveBeenCalled();
		expect(sourceImporter).toHaveBeenCalledOnce();
		expect(sourceImporter).toHaveBeenCalledWith("/source.ts");
	});

	it("propagates source import failures", async () => {
		const sourceImporter = vi.fn(async () => { throw new Error("source failed"); });
		await expect(importExtensionEntry({
			bundlePath: "/bundle.mjs",
			sourcePath: "/source.ts",
			useBundle: false,
			bundleImporter: vi.fn(),
			sourceImporter,
		})).rejects.toThrow("source failed");
	});
});
