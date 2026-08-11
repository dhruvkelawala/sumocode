import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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
const tsconfigPath = resolve(root, "tsconfig.json");
const packageJsonPath = resolve(root, "package.json");
const lockfilePath = resolve(root, "pnpm-lock.yaml");
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
		const [bundle, newestSource, buildRecipe, tsconfig, packageJson, lockfile, sourceFace, sourceFaceBytes, bundledFaceBytes, sourceSpawnHelperBytes, bundledSpawnHelperBytes] = await Promise.all([
			stat(bundlePath),
			newestSourceMtime(resolve(root, "src")),
			// Build options, compiler semantics, package metadata, and the resolved
			// bundler can change without touching src/. Treat each as an input.
			stat(buildRecipePath),
			stat(tsconfigPath),
			stat(packageJsonPath),
			stat(lockfilePath),
			stat(sourceFacePath),
			readFile(sourceFacePath),
			readFile(bundledFacePath),
			readFile(sourceSpawnHelperPath),
			readFile(bundledSpawnHelperPath),
		]);
		return bundle.mtimeMs >= Math.max(
			newestSource,
			buildRecipe.mtimeMs,
			tsconfig.mtimeMs,
			packageJson.mtimeMs,
			lockfile.mtimeMs,
			sourceFace.mtimeMs,
		)
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

const PRE_ADOPTION_KILL_GRACE_MS = 250;
let preSpawnedChild;
let relayingEarlySignal = false;
const handleEarlySigint = () => relayEarlySignal("SIGINT");
const handleEarlySigterm = () => relayEarlySignal("SIGTERM");

async function importSourceHost() {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, {
		moduleCache: true,
		tryNative: false,
	});
	return jiti.import("./src/sumo-tui/rpc/host.ts");
}

function childHasExited() {
	return !preSpawnedChild || preSpawnedChild.exitCode !== null || preSpawnedChild.signalCode !== null;
}

async function waitForPreSpawnedChildExit(timeoutMs) {
	if (childHasExited()) return true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			preSpawnedChild?.removeListener("exit", onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(childHasExited()), timeoutMs);
		preSpawnedChild.once("exit", onExit);
	});
}

async function terminateUnadoptedChild() {
	if (childHasExited()) return;
	try {
		preSpawnedChild.kill("SIGTERM");
	} catch {
		// The process may have exited between the state check and kill.
	}
	if (await waitForPreSpawnedChildExit(PRE_ADOPTION_KILL_GRACE_MS)) return;
	try {
		preSpawnedChild.kill("SIGKILL");
	} catch {
		// SIGTERM may have landed at the grace boundary.
	}
	await waitForPreSpawnedChildExit(PRE_ADOPTION_KILL_GRACE_MS);
}

function releasePreAdoptionSignalHandlers() {
	process.removeListener("SIGINT", handleEarlySigint);
	process.removeListener("SIGTERM", handleEarlySigterm);
}

function relayEarlySignal(signal) {
	if (relayingEarlySignal) return;
	relayingEarlySignal = true;
	// Keep both guarded listeners installed until child reaping finishes. Any
	// repeated signal re-enters this function, sees relayingEarlySignal, and is
	// suppressed instead of restoring Node's default disposition mid-cleanup.
	void terminateUnadoptedChild().finally(() => {
		releasePreAdoptionSignalHandlers();
		// Match the steady-state host contract: SIGTERM is a graceful exit, while
		// SIGINT is 130. Record the side channel before exiting so bash never
		// substitutes a timing-dependent 143 for an early SIGTERM.
		const code = signal === "SIGTERM" ? 0 : 130;
		const exitCodePath = process.env.SUMOCODE_EXIT_CODE_FILE;
		if (exitCodePath) {
			try {
				writeFileSync(exitCodePath, String(code));
			} catch {
				// The launcher falls back to the process status when this is unwritable.
			}
		}
		process.exit(code);
	});
}

// Keep this pre-spawn before importing either host implementation. Install the
// temporary signal owners before spawn so the child cannot publish its PID
// while the host is still using Node's default signal disposition.
if (process.stdout.isTTY === true) {
	const plan = buildChildSpawnPlan({ ...process.env, SUMOCODE_ROOT_DIR: root }, process.argv.slice(2));
	if (plan) {
		process.on("SIGINT", handleEarlySigint);
		process.on("SIGTERM", handleEarlySigterm);
		try {
			preSpawnedChild = spawn(plan.command, [...plan.args], {
				cwd: plan.cwd,
				env: plan.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			// Spawn failures arrive asynchronously. Own the error immediately so it
			// cannot become an unhandled EventEmitter error while the host imports;
			// SumoRpcClient adopts and reports the saved error in start().
			preSpawnedChild.once("error", (error) => {
				preSpawnedChild[Symbol.for("sumocode.rpc.preSpawnError")] = error;
			});
		} catch {
			preSpawnedChild = undefined;
			releasePreAdoptionSignalHandlers();
		}
	}
}

// Integration-only seam that pins the otherwise sub-millisecond ownership
// phase long enough to deliver a real PTY signal; inert outside NODE_ENV=test.
const preAdoptionTestDelayMs = process.env.NODE_ENV === "test"
	? Number.parseInt(process.env.SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS ?? "0", 10)
	: 0;
if (Number.isFinite(preAdoptionTestDelayMs) && preAdoptionTestDelayMs > 0) {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, preAdoptionTestDelayMs));
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
	await terminateUnadoptedChild();
	releasePreAdoptionSignalHandlers();
	throw error;
}
try {
	await mod.main({
		preSpawnedChild,
		onPreSpawnedChildAdopted: releasePreAdoptionSignalHandlers,
	});
} catch (error) {
	// main() can reject before SumoRpcClient adopts the pre-spawned child
	// (Yoga/config/runtime initialization). The entry still owns it then.
	await terminateUnadoptedChild();
	throw error;
} finally {
	releasePreAdoptionSignalHandlers();
}
