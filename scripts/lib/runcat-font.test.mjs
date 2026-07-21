import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RUNCAT_FONT_SHA256,
	checkFontFile,
	checkInstalledRuncatFont,
	installRuncatFont,
	resolveUserFontDestination,
	resolveVendoredFontPath,
	sha256File,
	verifyVendoredSource,
} from "./runcat-font.mjs";

const repoRoot = process.cwd();
const source = resolveVendoredFontPath(repoRoot);
let root;

beforeEach(() => {
	root = join(tmpdir(), `sumocode-runcat-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("RunCat font path helpers", () => {
	it("resolves macOS and Linux per-user destinations", () => {
		expect(resolveUserFontDestination({ platform: "darwin", home: "/Users/test" })).toBe("/Users/test/Library/Fonts/runcat.ttf");
		expect(resolveUserFontDestination({ platform: "linux", home: "/home/test" })).toBe("/home/test/.local/share/fonts/runcat.ttf");
	});

	it("verifies the pinned vendored source", () => {
		expect(sha256File(source)).toBe(RUNCAT_FONT_SHA256);
		expect(verifyVendoredSource(source)).toMatchObject({ status: "verified", bytes: 3532 });
	});
});

describe("checkFontFile", () => {
	it("distinguishes missing, mismatched, symlink, and verified files", () => {
		const missing = join(root, "missing.ttf");
		expect(checkFontFile(missing)).toMatchObject({ status: "missing" });
		const bad = join(root, "bad.ttf");
		writeFileSync(bad, "bad");
		expect(checkFontFile(bad)).toMatchObject({ status: "hash-mismatch" });
		const link = join(root, "link.ttf");
		symlinkSync(bad, link);
		expect(checkFontFile(link)).toMatchObject({ status: "invalid", reason: "symlink" });
		expect(checkFontFile(source)).toMatchObject({ status: "verified" });
	});
});

describe("installRuncatFont", () => {
	it("installs with no-clobber publication and cleans temporary files", () => {
		const destinationPath = join(root, "Library", "Fonts", "runcat.ttf");
		const result = installRuncatFont({ sourcePath: source, destinationPath });
		expect(result).toMatchObject({ ok: true, action: "installed" });
		expect(checkFontFile(destinationPath)).toMatchObject({ status: "verified" });
		expect(existsSync(join(root, "Library", "Fonts"))).toBe(true);
		const leftovers = readdirSync(join(root, "Library", "Fonts")).filter((name) => name.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("is idempotent for an already-correct destination", () => {
		const destinationPath = join(root, "runcat.ttf");
		expect(installRuncatFont({ sourcePath: source, destinationPath })).toMatchObject({ ok: true, action: "installed" });
		expect(installRuncatFont({ sourcePath: source, destinationPath })).toMatchObject({ ok: true, action: "already-installed" });
	});

	it("refuses mismatched, symlink, and non-regular destinations", () => {
		const bad = join(root, "bad.ttf");
		writeFileSync(bad, "bad");
		expect(installRuncatFont({ sourcePath: source, destinationPath: bad })).toMatchObject({ ok: false, action: "refused", destination: { status: "hash-mismatch" } });
		const link = join(root, "link.ttf");
		symlinkSync(bad, link);
		expect(installRuncatFont({ sourcePath: source, destinationPath: link })).toMatchObject({ ok: false, action: "refused", destination: { status: "invalid", reason: "symlink" } });
		const dir = join(root, "dir.ttf");
		mkdirSync(dir);
		expect(installRuncatFont({ sourcePath: source, destinationPath: dir })).toMatchObject({ ok: false, action: "refused", destination: { status: "invalid", reason: "not-regular-file" } });
	});

	it("refuses missing or bad sources", () => {
		const missing = join(root, "missing.ttf");
		expect(installRuncatFont({ sourcePath: missing, destinationPath: join(root, "dest.ttf") })).toMatchObject({ ok: false, action: "refused", source: { status: "missing" } });
		const bad = join(root, "bad-source.ttf");
		writeFileSync(bad, "bad");
		expect(installRuncatFont({ sourcePath: bad, destinationPath: join(root, "dest.ttf") })).toMatchObject({ ok: false, action: "refused", source: { status: "hash-mismatch" } });
	});

	it("handles an EEXIST publication race as idempotent only for a verified file", () => {
		const destinationPath = join(root, "race.ttf");
		const result = installRuncatFont({
			sourcePath: source,
			destinationPath,
			beforePublish: () => installRuncatFont({ sourcePath: source, destinationPath }),
		});
		expect(result).toMatchObject({ ok: true, action: "already-installed" });
	});
});

describe("checkInstalledRuncatFont", () => {
	it("returns structured status without writing", () => {
		const destinationPath = join(root, "missing.ttf");
		const before = existsSync(destinationPath);
		const result = checkInstalledRuncatFont({ sourcePath: source, destinationPath });
		expect(result).toMatchObject({ ok: false, source: { status: "verified" }, destination: { status: "missing" } });
		expect(existsSync(destinationPath)).toBe(before);
	});
});
