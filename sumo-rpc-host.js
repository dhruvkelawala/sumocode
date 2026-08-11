import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildChildSpawnPlan } from "./src/sumo-tui/rpc/spawn-child.mjs";

// Executable host code belongs to this installed package, never the project
// cwd. The launcher passes SUMOCODE_ROOT_DIR explicitly; direct/manual entry
// invocation safely defaults to the directory containing this entry file.
const root = resolve(process.env.SUMOCODE_ROOT_DIR ?? dirname(fileURLToPath(import.meta.url)));
const bundlePath = resolve(root, "dist/host/sumo-rpc-host.bundle.mjs");
const buildRecipePath = resolve(root, "scripts/build-host.mjs");
const sourceFacePath = resolve(root, "src/assets/sumo-face.ans");
const bundledFacePath = resolve(root, "dist/host/assets/sumo-face.ans");
const sourceSpawnHelperPath = resolve(root, "src/sumo-tui/rpc/spawn-child.mjs");
const bundledSpawnHelperPath = resolve(root, "dist/host/spawn-child.mjs");

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
		const [bundle, newestSource, buildRecipe, sourceFace, sourceFaceBytes, bundledFaceBytes, sourceSpawnHelperBytes, bundledSpawnHelperBytes] = await Promise.all([
			stat(bundlePath),
			newestSourceMtime(resolve(root, "src")),
			// Build options, externals, copied outputs, or the target can change
			// without touching src/. Treat the recipe itself as a bundle input.
			stat(buildRecipePath),
			stat(sourceFacePath),
			readFile(sourceFacePath),
			readFile(bundledFacePath),
			readFile(sourceSpawnHelperPath),
			readFile(bundledSpawnHelperPath),
		]);
		return bundle.mtimeMs >= Math.max(newestSource, buildRecipe.mtimeMs, sourceFace.mtimeMs)
			&& sourceFaceBytes.equals(bundledFaceBytes)
			&& sourceSpawnHelperBytes.equals(bundledSpawnHelperBytes);
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
	const plan = buildChildSpawnPlan({ ...process.env, SUMOCODE_ROOT_DIR: root }, process.argv.slice(2));
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

function terminateUnadoptedChild() {
	if (!preSpawnedChild || preSpawnedChild.exitCode !== null || preSpawnedChild.signalCode !== null) return;
	try {
		preSpawnedChild.kill("SIGTERM");
	} catch {
		// The process may have exited between the state check and kill.
	}
}

let mod;
try {
	if (forceBundle && !bundleExists) {
		throw new Error(`[sumocode] forced host bundle is missing: ${bundlePath}`);
	}
	if (bundleFresh) {
		try {
			mod = await import(pathToFileURL(bundlePath).href);
		} catch (error) {
			if (forceBundle) {
				throw new Error(`[sumocode] forced host bundle failed to import: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
			mod = await importSourceHost();
		}
	} else {
		mod = await importSourceHost();
	}
} catch (error) {
	terminateUnadoptedChild();
	throw error;
}
try {
	await mod.main({ preSpawnedChild });
} catch (error) {
	// main() can reject before SumoRpcClient adopts the pre-spawned child
	// (Yoga/config/runtime initialization). The entry still owns it then.
	terminateUnadoptedChild();
	throw error;
}
