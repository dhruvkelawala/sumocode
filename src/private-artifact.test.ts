import { lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertArtifactInsideDir,
	assertPrivateArtifact,
	assertPrivateDir,
	PRIVATE_FILE_MODE,
	type PrivateArtifactFs,
	type PrivateArtifactStat,
} from "./private-artifact.js";

// SAFETY: the real Stats object satisfies the structural PrivateArtifactStat subset.
const nodeFs: PrivateArtifactFs = { lstatSync: (path) => lstatSync(path) as PrivateArtifactStat };

let workDir: string | undefined;

afterEach(() => {
	workDir = undefined;
});

const freshDir = (name: string): string => {
	workDir = mkdtempSync(join(tmpdir(), `sumocode-private-artifact-${name}-`));
	return workDir;
};

describe("private artifact boundary", () => {
	it("accepts a private directory we own", () => {
		const dir = freshDir("dir");
		const private_ = join(dir, "task");
		mkdirSync(private_, { mode: 0o700 });
		expect(() => assertPrivateDir(nodeFs, private_, "task dir")).not.toThrow();
	});

	it("refuses a control dir with group/other permissions", () => {
		const dir = freshDir("mode");
		const open = join(dir, "open");
		mkdirSync(open, { mode: 0o755 });
		expect(() => assertPrivateDir(nodeFs, open, "control dir")).toThrow(/not owner-only/);
	});

	it("refuses a symlink planted at the directory path", () => {
		const dir = freshDir("symlink-dir");
		const target = join(dir, "elsewhere");
		mkdirSync(target);
		const planted = join(dir, "control");
		symlinkSync(target, planted);
		expect(() => assertPrivateDir(nodeFs, planted, "control dir")).toThrow(/not a directory/);
	});

	it("accepts a private regular artifact inside its parent", () => {
		const dir = freshDir("file");
		const file = join(dir, "steer-1.txt");
		writeFileSync(file, "text", { mode: PRIVATE_FILE_MODE });
		expect(() => assertPrivateArtifact(nodeFs, file, dir, "steer control")).not.toThrow();
	});

	it("refuses an artifact that escapes its parent directory", () => {
		const dir = freshDir("escape");
		const file = join(dir, "steer-1.txt");
		writeFileSync(file, "text", { mode: PRIVATE_FILE_MODE });
		expect(() => assertPrivateArtifact(nodeFs, file, join(dir, "control"), "steer control")).toThrow(/direct child/);
	});

	it("refuses a symlink replaced artifact without following it", () => {
		const dir = freshDir("symlink-file");
		const outside = join(dir, "victim.txt");
		writeFileSync(outside, "secret", { mode: PRIVATE_FILE_MODE });
		const file = join(dir, "steer-1.txt");
		symlinkSync(outside, file);
		expect(() => assertPrivateArtifact(nodeFs, file, dir, "steer control")).toThrow(/not a regular file/);
	});

	it("refuses a world-readable artifact", () => {
		const dir = freshDir("file-mode");
		const file = join(dir, "exit.code");
		writeFileSync(file, "0", { mode: 0o644 });
		expect(() => assertPrivateArtifact(nodeFs, file, dir, "exit marker")).toThrow(/not owner-only/);
	});

	it("confines not-yet-existing artifact paths", () => {
		const dir = freshDir("confine");
		expect(() => assertArtifactInsideDir(join(dir, "response.md"), dir, "response")).not.toThrow();
		expect(() => assertArtifactInsideDir(join(dir, "sub", "response.md"), dir, "response")).toThrow(/direct child/);
	});
});
