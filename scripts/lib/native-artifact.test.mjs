import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNativeArtifactIdentity, writeNativeBuildIdentity } from "./native-artifact.mjs";

const roots = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureArtifact(sourceClean = true) {
	const root = await mkdtemp(join(tmpdir(), "sumocode-native-artifact-"));
	roots.push(root);
	for (const path of [
		"bin/sumocode",
		"bin/sumocode-pi",
		"extension/sumocode-extension.bundle.mjs",
		"extension/sumocode-rpc-extension.bundle.mjs",
	]) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), `${path}\n`);
	}
	await writeFile(join(root, "build.json"), `${JSON.stringify({
		schemaVersion: 1,
		sourceCommit: "a".repeat(40),
		sourceClean,
	}, null, 2)}\n`);
	const files = [
		"bin/sumocode",
		"bin/sumocode-pi",
		"build.json",
		"extension/sumocode-extension.bundle.mjs",
		"extension/sumocode-rpc-extension.bundle.mjs",
	];
	const lines = [];
	for (const path of files) {
		const bytes = await readFile(join(root, path));
		lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${path}`);
	}
	await writeFile(join(root, "SHA256SUMS"), `${lines.join("\n")}\n`);
	return root;
}

describe("native artifact identity", () => {
	it("binds a clean source commit to checksum-verified native files", async () => {
		const root = await fixtureArtifact();
		const identity = await readNativeArtifactIdentity(root);

		expect(identity).toMatchObject({
			sourceCommit: "a".repeat(40),
			sourceClean: true,
			artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(identity.files).toHaveLength(5);
	});

	it("rejects dirty or mutated artifacts", async () => {
		await expect(readNativeArtifactIdentity(await fixtureArtifact(false))).rejects.toThrow("dirty source");
		const root = await fixtureArtifact();
		await writeFile(join(root, "bin/sumocode"), "rebuilt after checksums\n");
		await expect(readNativeArtifactIdentity(root)).rejects.toThrow("checksum mismatch");
	});

	it("writes source identity without requiring a clean developer checkout", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-native-build-id-"));
		roots.push(root);
		const out = join(root, "archive");
		await mkdir(out);
		await writeNativeBuildIdentity(root, out, async (args) => args[0] === "rev-parse" ? "b".repeat(40) : " M src/file.ts");
		const manifest = JSON.parse(await readFile(join(out, "build.json"), "utf8"));
		expect(manifest).toEqual({ schemaVersion: 1, sourceCommit: "b".repeat(40), sourceClean: false });
	});
});
