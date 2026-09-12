import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { EditorImageAttachment } from "../../cathedral/editor-draft-state.js";

export const MAX_RPC_IMAGE_BYTES = 3 * 1024 * 1024;

interface LoadRpcImagesOptions {
	readonly cwd?: string;
	readonly home?: string;
	readonly maxBytes?: number;
}

class RpcImageLoadError extends Error {
	public constructor(attachment: EditorImageAttachment, reason: string) {
		super(`${attachment.token} (${basename(attachment.path)}): ${reason}`);
		this.name = "RpcImageLoadError";
	}
}

export async function loadRpcImages(
	attachments: readonly EditorImageAttachment[],
	options: LoadRpcImagesOptions = {},
): Promise<ImageContent[]> {
	const images: ImageContent[] = [];
	for (const attachment of attachments) {
		const path = resolveImagePath(attachment.path, options.cwd ?? process.cwd(), options.home ?? homedir());
		let file;
		try {
			file = await stat(path);
		} catch {
			throw new RpcImageLoadError(attachment, "file not found or unreadable");
		}
		if (!file.isFile()) throw new RpcImageLoadError(attachment, "path is not a regular file");
		const maxBytes = options.maxBytes ?? MAX_RPC_IMAGE_BYTES;
		if (file.size > maxBytes) throw new RpcImageLoadError(attachment, `image exceeds ${maxBytes} byte limit`);

		let bytes: Buffer;
		try {
			bytes = await readFile(path);
		} catch {
			throw new RpcImageLoadError(attachment, "file not found or unreadable");
		}
		const detected = detectImageMime(bytes);
		const expected = mimeForExtension(extname(path));
		if (!detected || !expected) throw new RpcImageLoadError(attachment, "file does not contain a supported image");
		if (detected !== expected) throw new RpcImageLoadError(attachment, `file content is ${detected}, not ${expected}`);
		images.push({ type: "image", data: bytes.toString("base64"), mimeType: detected });
	}
	return images;
}

function resolveImagePath(path: string, cwd: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return resolve(cwd, path);
}

function mimeForExtension(extension: string): string | undefined {
	switch (extension.toLowerCase()) {
		case ".gif": return "image/gif";
		case ".jpeg":
		case ".jpg": return "image/jpeg";
		case ".png": return "image/png";
		case ".webp": return "image/webp";
		default: return undefined;
	}
}

function detectImageMime(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && asciiAt(bytes, 12, "IHDR")) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
	if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
	return undefined;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return prefix.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	return [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
