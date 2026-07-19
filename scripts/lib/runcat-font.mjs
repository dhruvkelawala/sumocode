import { copyFileSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export const RUNCAT_FONT_SHA256 = "3c5be14dc51cd0d21b34cbd40fe147ff61480ce03655eb43571008975b395d94";
const RUNCAT_FONT_BYTES = 3532;
const RUNCAT_FONT_FILENAME = "runcat.ttf";

export function resolveVendoredFontPath(repoRoot = process.cwd()) {
	return resolve(repoRoot, "assets", "fonts", RUNCAT_FONT_FILENAME);
}

export function resolveUserFontDestination(options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? process.env.HOME;
	if (!home) throw new Error("Cannot resolve user font directory: HOME is unset");
	if (platform === "darwin") return join(home, "Library", "Fonts", RUNCAT_FONT_FILENAME);
	return join(home, ".local", "share", "fonts", RUNCAT_FONT_FILENAME);
}

export function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function checkFontFile(path, expectedSha256 = RUNCAT_FONT_SHA256) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "missing", path };
		throw error;
	}
	if (stat.isSymbolicLink()) return { status: "invalid", reason: "symlink", path };
	if (!stat.isFile()) return { status: "invalid", reason: "not-regular-file", path };
	const sha256 = sha256File(path);
	if (sha256 !== expectedSha256) return { status: "hash-mismatch", path, sha256, expectedSha256 };
	return { status: "verified", path, sha256, bytes: stat.size };
}

export function verifyVendoredSource(path = resolveVendoredFontPath()) {
	const result = checkFontFile(path);
	if (result.status !== "verified") return result;
	if (result.bytes !== RUNCAT_FONT_BYTES) return { status: "size-mismatch", path, bytes: result.bytes, expectedBytes: RUNCAT_FONT_BYTES };
	return result;
}

export function checkInstalledRuncatFont(options = {}) {
	const sourcePath = options.sourcePath ?? resolveVendoredFontPath(options.repoRoot);
	const destinationPath = options.destinationPath ?? resolveUserFontDestination(options);
	const source = verifyVendoredSource(sourcePath);
	const destination = checkFontFile(destinationPath);
	return { ok: source.status === "verified" && destination.status === "verified", source, destination };
}

export function installRuncatFont(options = {}) {
	const sourcePath = options.sourcePath ?? resolveVendoredFontPath(options.repoRoot);
	const destinationPath = options.destinationPath ?? resolveUserFontDestination(options);
	const source = verifyVendoredSource(sourcePath);
	if (source.status !== "verified") return { ok: false, action: "refused", source, destination: { status: "unchecked", path: destinationPath } };

	const existing = checkFontFile(destinationPath);
	if (existing.status === "verified") return { ok: true, action: "already-installed", source, destination: existing };
	if (existing.status !== "missing") return { ok: false, action: "refused", source, destination: existing };

	mkdirSync(dirname(destinationPath), { recursive: true });
	const tempPath = join(dirname(destinationPath), `.${RUNCAT_FONT_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
	try {
		copyFileSync(sourcePath, tempPath, constants.COPYFILE_EXCL);
		const fd = openSync(tempPath, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const temp = verifyVendoredSource(tempPath);
		if (temp.status !== "verified") return { ok: false, action: "refused", source, destination: temp };
		options.beforePublish?.(tempPath, destinationPath);
		try {
			linkSync(tempPath, destinationPath);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const raced = checkFontFile(destinationPath);
			return raced.status === "verified"
				? { ok: true, action: "already-installed", source, destination: raced }
				: { ok: false, action: "refused", source, destination: raced };
		}
		const installed = checkFontFile(destinationPath);
		return { ok: installed.status === "verified", action: "installed", source, destination: installed };
	} finally {
		if (existsSync(tempPath)) rmSync(tempPath, { force: true });
	}
}
