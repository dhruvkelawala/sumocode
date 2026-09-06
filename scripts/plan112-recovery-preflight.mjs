#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateFakeProvider } from "../test/integration/fixtures/plan112-fake-provider.mjs";

export const recoveryRepo = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

/** No inherited credentials, user config, preload flags, or shared cache. */
export function recoveryEnvironment(root) {
	return {
		HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"),
		XDG_CACHE_HOME: join(root, "cache"), PI_CODING_AGENT_DIR: join(root, "config"),
		PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin`,
		CI: "1", NO_COLOR: "1", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
		NODE_COMPILE_CACHE: join(root, "cache"), JITI_FS_CACHE: "false",
	};
}

export async function preflightRecovery(root) {
	assert(process.platform !== "win32", "preflight: POSIX required");
	assert(isAbsolute(root) && realpathSync(root) === root, "preflight: canonical private root required");
	const stat = lstatSync(root);
	assert(stat.isDirectory() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(), "preflight: root must be owned 0700");
	assert(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, "preflight: preload overrides forbidden");
	const node = realpathSync(process.execPath);
	const nodeStat = lstatSync(node);
	assert(!process.versions.bun && isAbsolute(node) && basename(node) === "node" && nodeStat.isFile()
		&& !(nodeStat.mode & 0o022) && (nodeStat.mode & 0o111), "preflight: trusted absolute Node required");
	for (const name of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
		const packageDir = realpathSync(join(recoveryRepo, "node_modules/@earendil-works", name));
		assert.equal(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version, "0.84.4", `preflight: checkout-local ${name} must be 0.84.4`);
	}
	const pi = realpathSync(join(recoveryRepo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
	assert(/^#!.*node\n/u.test(readFileSync(pi, "utf8")), "preflight: Node Pi CLI required");
	assert(!(lstatSync(pi).mode & 0o022), "preflight: writable Pi CLI refused");
	for (const directory of ["home", "tmp", "config", "cache", "cwd"]) mkdirSync(join(root, directory), { mode: 0o700 });
	const ai = realpathSync(join(recoveryRepo, "node_modules/@earendil-works/pi-ai/dist/index.js"));
	const provider = generateFakeProvider(root, ai);
	const { default: factory } = await import(pathToFileURL(provider).href);
	let registered = false;
	factory({ registerProvider(name, config) {
		assert.equal(name, "source-proof");
		assert.equal(config.models[0].id, "fixed");
		assert(config.streamSimple instanceof Function, "preflight: generated stream factory missing");
		registered = true;
	} });
	assert(registered, "preflight: provider generation/load failed");
	return { node, pi, provider, env: recoveryEnvironment(root) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await preflightRecovery(process.argv[2]);
		process.stdout.write("plan112 preflight: checkout-local Pi 0.84.4, absolute Node, private provider PASS\n");
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "preflight failed"}\n`);
		process.exitCode = 1;
	}
}
