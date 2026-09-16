import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUIRED_FILES = Object.freeze([
	"bin/sumocode",
	"bin/sumocode-pi",
	"build.json",
	"extension/sumocode-extension.bundle.mjs",
	"extension/sumocode-rpc-extension.bundle.mjs",
]);

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function defaultRunGit(root, args) {
	return (await execFileAsync("git", args, { cwd: root, encoding: "utf8" })).stdout.trim();
}

/** Record which source tree produced a native archive without blocking ordinary dirty builds. */
export async function writeNativeBuildIdentity(root, archiveDir, runGit = (args) => defaultRunGit(root, args)) {
	const sourceCommit = await runGit(["rev-parse", "HEAD"]);
	if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("native build source commit is invalid");
	const status = await runGit(["status", "--porcelain", "--untracked-files=all"]);
	const identity = { schemaVersion: 1, sourceCommit, sourceClean: status.length === 0 };
	await writeFile(resolve(archiveDir, "build.json"), `${JSON.stringify(identity, null, 2)}\n`);
	return identity;
}

function checkedRelativePath(path) {
	const normalized = path.replaceAll("\\", "/");
	if (normalized.length === 0 || isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`invalid native artifact checksum path: ${path}`);
	}
	return normalized;
}

/** Verify an immutable native archive and return the source/artifact identity used in reports. */
export async function readNativeArtifactIdentity(archiveDir) {
	const root = await realpath(archiveDir);
	const checksumBytes = await readFile(resolve(root, "SHA256SUMS"));
	const manifest = JSON.parse(await readFile(resolve(root, "build.json"), "utf8"));
	if (manifest?.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? "")) {
		throw new Error(`native artifact at ${archiveDir} has invalid build identity`);
	}
	if (manifest.sourceClean !== true) throw new Error(`native artifact at ${archiveDir} was built from dirty source`);

	const files = [];
	const seen = new Set();
	for (const line of checksumBytes.toString("utf8").split("\n").filter(Boolean)) {
		const match = line.match(/^([0-9a-f]{64})  (.+)$/u);
		if (!match) throw new Error(`invalid native artifact checksum line: ${line}`);
		const path = checkedRelativePath(match[2]);
		if (seen.has(path)) throw new Error(`duplicate native artifact checksum path: ${path}`);
		seen.add(path);
		const absolute = resolve(root, path);
		const relativePath = relative(root, absolute);
		if (relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
			throw new Error(`native artifact checksum path escapes archive: ${path}`);
		}
		const info = await lstat(absolute);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error(`native artifact checksum path is not a regular file: ${path}`);
		if (sha256(await readFile(absolute)) !== match[1]) throw new Error(`native artifact checksum mismatch: ${path}`);
		files.push(path);
	}
	for (const path of REQUIRED_FILES) {
		if (!seen.has(path)) throw new Error(`native artifact checksum is missing required file: ${path}`);
	}
	return {
		artifactDir: root,
		sourceCommit: manifest.sourceCommit,
		sourceClean: true,
		artifactSha256: sha256(checksumBytes),
		files,
	};
}
