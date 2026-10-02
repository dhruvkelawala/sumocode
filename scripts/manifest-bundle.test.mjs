import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { steeringAckBoundary } from "./lib/steering-ack-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
it.each(["import './manifest-effect.js';", "void import('./manifest-effect.js');"])("rejects an unreviewed manifest implementation edge: %s", async (contents) => {
	await expect(build({
		stdin: { contents, resolveDir: join(root, "src/subagents"), sourcefile: "wrong-owner.ts" },
		bundle: true, write: false, plugins: [steeringAckBoundary], logLevel: "silent",
	})).rejects.toThrow("collector-owned dynamic import");
});
