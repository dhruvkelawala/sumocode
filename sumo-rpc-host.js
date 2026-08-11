import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildChildSpawnPlan } from "./src/sumo-tui/rpc/spawn-child.mjs";

const root = resolve(process.env.SUMOCODE_ROOT_DIR ?? process.cwd());
const bundlePath = resolve(root, "dist/host/sumo-rpc-host.bundle.mjs");
const sourceFacePath = resolve(root, "src/assets/sumo-face.ans");
const bundledFacePath = resolve(root, "dist/host/assets/sumo-face.ans");

async function newestSourceMtime(directory) {
	let newest = 0;
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			newest = Math.max(newest, await newestSourceMtime(path));
		} else if ((entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) || entry.name.endsWith(".mjs")) {
			newest = Math.max(newest, (await stat(path)).mtimeMs);
		}
	}
	return newest;
}

async function bundleIsFresh() {
	try {
		const [bundle, newestSource, sourceFace, sourceFaceBytes, bundledFaceBytes] = await Promise.all([
			stat(bundlePath),
			newestSourceMtime(resolve(root, "src")),
			stat(sourceFacePath),
			readFile(sourceFacePath),
			readFile(bundledFacePath),
		]);
		return bundle.mtimeMs >= Math.max(newestSource, sourceFace.mtimeMs) && sourceFaceBytes.equals(bundledFaceBytes);
	} catch {
		return false;
	}
}

const useBundle = process.env.SUMOCODE_HOST_BUNDLE !== "0";
const forceBundle = process.env.SUMOCODE_HOST_BUNDLE === "1";
const bundleExists = await stat(bundlePath).then(() => true, () => false);
const bundleFresh = bundleExists && (forceBundle || (useBundle && await bundleIsFresh()));
if (useBundle && bundleExists && !forceBundle && !bundleFresh) {
	process.stderr.write("[sumocode] host bundle stale — using source; run pnpm build:host\n");
}

// Keep this pre-spawn before importing either host implementation. The bundle
// has the same createRequire() contract as the source host, but its module
// URL is dist/host/, so build-host.mjs copies spawn-child.mjs beside it.
const preSpawnedChild = (() => {
	if (process.stdout.isTTY !== true) return undefined;
	const plan = buildChildSpawnPlan(process.env, process.argv.slice(2));
	if (!plan) return undefined;
	try {
		const child = spawn(plan.command, [...plan.args], {
			cwd: plan.cwd,
			env: plan.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// spawn failures arrive asynchronously. Own the error immediately so it
		// cannot become an unhandled EventEmitter error while jiti imports the
		// host; SumoRpcClient adopts and reports the saved error in start().
		child.once("error", (error) => {
			child[Symbol.for("sumocode.rpc.preSpawnError")] = error;
		});
		return child;
	} catch {
		return undefined;
	}
})();

async function importSourceHost() {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		tryNative: false,
	});
	return jiti.import("./src/sumo-tui/rpc/host.ts");
}

let mod;
try {
	if (bundleFresh) {
		try {
			mod = await import(pathToFileURL(bundlePath).href);
		} catch {
			mod = await importSourceHost();
		}
	} else {
		mod = await importSourceHost();
	}
} catch (error) {
	preSpawnedChild?.kill("SIGTERM");
	throw error;
}
await mod.main({ preSpawnedChild });
