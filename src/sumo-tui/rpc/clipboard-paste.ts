/**
 * Clipboard-image paste for the RPC host editor (Ctrl+V →
 * `app.clipboard.pasteImage`).
 *
 * Pi's interactive mode reads the clipboard image, writes it to a
 * `pi-clipboard-<uuid>.<ext>` temp file, and inserts the path into the
 * editor. The RPC host never wired this, so Ctrl+V was a silent no-op.
 *
 * The reader lives in `@earendil-works/pi-coding-agent`'s
 * `dist/utils/clipboard-image.js`, which is NOT importable as a bare
 * subpath — the package's `exports` map restricts it to the `"."` entry
 * (same situation as the keybindings table, see rpc/editor.ts). Unlike the
 * keybindings case there is no public-surface equivalent to mirror: the
 * util wraps a native clipboard binding plus per-platform fallbacks
 * (osascript/PowerShell/wl-paste) and Photon-based mime conversion, which
 * is not reasonable to reimplement. Instead we resolve the package's real
 * entry file and deep-import the util by FILE URL (exports maps only
 * constrain bare specifiers, not direct file imports). If pi moves the
 * file, the loader degrades to null and paste stays a no-op instead of
 * crashing the host.
 */

import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ClipboardImageReader {
	readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
	extensionForImageMimeType(mimeType: string): string | null;
}

let cachedLoader: Promise<ClipboardImageReader | null> | undefined;

const CLIPBOARD_IMAGE_MODULE_SUBPATH = join(
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"utils",
	"clipboard-image.js",
);

/**
 * Locate pi's clipboard-image util by walking node_modules upward from this
 * module's directory (covers both the dev tree and the installed launcher
 * tree), falling back to the process cwd chain.
 */
export function findClipboardImageModulePath(startDirs?: readonly string[]): string | null {
	const roots = startDirs ?? [dirname(fileURLToPath(import.meta.url)), process.cwd()];
	for (const root of roots) {
		let dir = root;
		for (;;) {
			const candidate = join(dir, CLIPBOARD_IMAGE_MODULE_SUBPATH);
			if (existsSync(candidate)) return candidate;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

function loadPiClipboardImageModule(): Promise<ClipboardImageReader | null> {
	cachedLoader ??= (async () => {
		try {
			// Resolver-free lookup: createRequire().resolve rejects the package
			// (its exports map defines no CJS entry) and jiti — which the RPC
			// host uses to load this TypeScript — shims import.meta.resolve with
			// CJS resolution, so BOTH standard routes throw at host runtime.
			// Walking node_modules on disk sidesteps resolver politics entirely
			// (pnpm's symlinked layout resolves through existsSync fine).
			const modulePath = findClipboardImageModulePath();
			if (!modulePath) return null;
			const mod = (await import(pathToFileURL(modulePath).href)) as Partial<ClipboardImageReader>;
			if (typeof mod.readClipboardImage !== "function" || typeof mod.extensionForImageMimeType !== "function") {
				return null;
			}
			return mod as ClipboardImageReader;
		} catch {
			return null;
		}
	})();
	return cachedLoader;
}

/** Test seam: forget the cached deep-import result. */
export function resetClipboardImageLoaderForTests(): void {
	cachedLoader = undefined;
}

/**
 * Read the clipboard image (if any) and persist it to a
 * `pi-clipboard-<uuid>.<ext>` temp file. Returns the file path, or null when
 * the clipboard has no image / the reader is unavailable.
 *
 * The `pi-clipboard-` prefix is deliberate: `isLikelyClipboardImagePath`
 * (cathedral/editor-draft-state.ts) matches it, which is what makes
 * `CathedralEditor.insertTextAtCursor` collapse the inserted path into a
 * compact `[Image N]` token instead of splattering a temp path into the
 * draft.
 */
export async function pasteClipboardImageToTempFile(reader?: ClipboardImageReader | null): Promise<string | null> {
	const mod = reader !== undefined ? reader : await loadPiClipboardImageModule();
	if (!mod) return null;
	try {
		const image = await mod.readClipboardImage();
		if (!image) return null;
		const ext = mod.extensionForImageMimeType(image.mimeType) ?? "png";
		const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
		writeFileSync(filePath, Buffer.from(image.bytes));
		return filePath;
	} catch {
		return null;
	}
}
