import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, expect, it } from "vitest";
import { assertNoEffectInEagerClosure, assertNoProductionDependencyLeakage, bundleJavaScriptText, moduleSpecifiers } from "./lib/production-boundaries.mjs";
import { buildSteeringAckBundle, STEERING_ACK_OUTPUT, steeringAckBoundary } from "./lib/steering-ack-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const directories = [];
afterAll(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });
const entries = ["src/extension.ts", "src/rpc-child-extension.ts", "src/sumo-tui/rpc/host.ts"];

it.each(entries)("%s stays cold in source and bundled profiles; its lazy artifact is self-contained", async (entry) => {
	const directory = await mkdtemp(join(tmpdir(), "sumocode-steering-lazy-"));
	directories.push(directory);
	await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
	const output = join(directory, "entry.mjs");
	const result = await build({
		absWorkingDir: root, entryPoints: [entry], outfile: output,
		bundle: true, platform: "node", format: "esm", packages: "external",
		metafile: true, write: false, plugins: [steeringAckBoundary],
	});
	const text = bundleJavaScriptText(result.outputFiles);
	assertNoEffectInEagerClosure(result.metafile, entry, entry);
	assertNoProductionDependencyLeakage(result.metafile, entry, text);
	if (entry === "src/sumo-tui/rpc/host.ts") expect(moduleSpecifiers(text)).not.toContain(`./${STEERING_ACK_OUTPUT}`);
	else expect(moduleSpecifiers(text)).toContain(`./${STEERING_ACK_OUTPUT}`);
	expect(Object.keys(result.metafile.inputs).some((path) => path.includes("/effect/"))).toBe(false);
	await writeFile(output, text);
	const lazy = await buildSteeringAckBundle(root, directory);
	const lazyText = bundleJavaScriptText(lazy.outputFiles);
	expect(Object.keys(lazy.metafile.inputs).some((path) => path.includes("/effect/"))).toBe(true);
	expect(moduleSpecifiers(lazyText).every((path) => path.startsWith("node:"))).toBe(true);
	await writeFile(join(directory, STEERING_ACK_OUTPUT), lazyText);

	// Fresh processes observe actual evaluation, not just source import spelling.
	for (const profile of ["source", "bundle"]) {
		const home = join(directory, profile);
		await mkdir(home);
		const diagnostic = join(home, "diagnostic.jsonl");
		const probe = join(directory, `probe-${profile}.mjs`);
		await writeFile(probe, `
import { createJiti } from "jiti";
const effects = [];
const original = Symbol.for;
Symbol.for = (key) => { if (key.startsWith("effect/")) effects.push(key); return original(key); };
const jiti = createJiti(import.meta.url);
await ${profile === "source" ? `jiti.import(${JSON.stringify(join(root, entry))})` : `import(${JSON.stringify(pathToFileURL(output).href)})`};
if (effects.length) throw new Error("eager Effect evaluation: " + effects.join(", "));
await ${profile === "source" ? `jiti.import(${JSON.stringify(join(root, "src/subagents/steering-ack-effect.ts"))})` : `import(${JSON.stringify(pathToFileURL(join(directory, STEERING_ACK_OUTPUT)).href)})`};
if (!effects.length) throw new Error("probe did not observe lazy Effect evaluation");
console.log("cold until steering");
`);
		const stdout = execFileSync(process.execPath, [probe], {
			cwd: root, encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: home, SUMO_TUI_DIAG_FILE: diagnostic },
		});
		expect(stdout).toContain("cold until steering");
		const events = (await readFile(diagnostic, "utf8")).trim().split("\n").map((line) => JSON.parse(line).event);
		expect(events.filter((event) => event === "visible_steering_effect_loaded")).toHaveLength(1);
	}
}, 30_000);

it.each(["import './steering-ack-effect.js';", "void import('./steering-ack-effect.js');"])("refuses an unreviewed implementation edge: %s", async (contents) => {
	await expect(build({
		stdin: { contents, resolveDir: join(root, "src/subagents"), sourcefile: "wrong-owner.ts" },
		bundle: true, write: false, plugins: [steeringAckBoundary], logLevel: "silent",
	})).rejects.toThrow("backend-owned dynamic import");
});
