import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostInputManifestIsFresh, hostOutputsHash, HOST_INPUT_MANIFEST_OUTPUT } from "./scripts/lib/host-bundle.mjs";
import { buildChildSpawnPlan } from "./src/sumo-tui/rpc/spawn-child.mjs";

// Executable host code belongs to this installed package, never the project
// cwd. The launcher passes SUMOCODE_ROOT_DIR explicitly; direct/manual entry
// invocation safely defaults to the directory containing this entry file.
const root = resolve(process.env.SUMOCODE_ROOT_DIR ?? dirname(fileURLToPath(import.meta.url)));
const bundlePath = resolve(root, "dist/host/sumo-rpc-host.bundle.mjs");
const inputManifestPath = resolve(root, "dist/host", HOST_INPUT_MANIFEST_OUTPUT);
const sourceFacePath = resolve(root, "src/assets/sumo-face.ans");
const bundledFacePath = resolve(root, "dist/host/assets/sumo-face.ans");
const sourceSpawnHelperPath = resolve(root, "src/sumo-tui/rpc/spawn-child.mjs");
const bundledSpawnHelperPath = resolve(root, "dist/host/spawn-child.mjs");

async function bundleIsFresh() {
	const testDelayMs = process.env.NODE_ENV === "test"
		? Number.parseInt(process.env.SUMOCODE_TEST_BUNDLE_SCAN_DELAY_MS ?? "0", 10)
		: 0;
	if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, testDelayMs));
	}
	try {
		const [manifestBytes, sourceFaceBytes, bundledFaceBytes, sourceSpawnHelperBytes, bundledSpawnHelperBytes] = await Promise.all([
			readFile(inputManifestPath, "utf8"),
			readFile(sourceFacePath),
			readFile(bundledFacePath),
			readFile(sourceSpawnHelperPath),
			readFile(bundledSpawnHelperPath),
		]);
		const manifest = JSON.parse(manifestBytes);
		// The manifest describes its own published outputs. Verify them so a bundle
		// from a different concurrent build (interleaved renames) is rejected in
		// favour of the source fallback.
		return await hostInputManifestIsFresh(root, manifest)
			&& typeof manifest.outputsHash === "string"
			&& await hostOutputsHash(root) === manifest.outputsHash
			&& sourceFaceBytes.equals(bundledFaceBytes)
			&& sourceSpawnHelperBytes.equals(bundledSpawnHelperBytes);
	} catch {
		return false;
	}
}

const useBundle = process.env.SUMOCODE_HOST_BUNDLE !== "0";
const forceBundle = process.env.SUMOCODE_HOST_BUNDLE === "1";

const PRE_ADOPTION_KILL_GRACE_MS = 250;
// Keep this dependency-free: it must run when host source/bundle imports are
// broken. Its mode-reset suffix mirrors TERMINAL_CLEANUP_SEQUENCE in
// terminal-controller.ts; rpc-host-shell.test.ts compares them to catch drift.
const RELOAD_FALLBACK_TERMINAL_CLEANUP =
	"\x1b]112\x1b\\" + // cursor colour reset
	"\x1b]111\x1b\\" + // terminal background reset
	"\x1b[<u" + // kitty keyboard pop
	"\x1b[>4;0m" + // xterm modifyOtherKeys off
	"\x1b[?2004l" + // bracketed paste off
	"\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l" + // mouse off
	"\x1b[?1049l" + // altscreen off
	"\x1b[?25h\x1b[0m"; // cursor visible + SGR reset
let preSpawnedChild;
let relayingEarlySignal = false;
let earlyCleanupPromise;
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

function restoreFailedReloadTerminal() {
	if (process.env.SUMOCODE_RELOAD !== "1" || process.stdout.isTTY !== true) return;
	try { process.stdin.setRawMode?.(false); } catch {}
	try { process.stdout.write(RELOAD_FALLBACK_TERMINAL_CLEANUP); } catch {}
}

function relayEarlySignal(signal) {
	if (relayingEarlySignal) return;
	relayingEarlySignal = true;
	// Keep both guarded listeners installed until child reaping finishes. Any
	// repeated signal re-enters this function, sees relayingEarlySignal, and is
	// suppressed instead of restoring Node's default disposition mid-cleanup.
	earlyCleanupPromise = terminateUnadoptedChild().finally(() => {
		releasePreAdoptionSignalHandlers();
		// A reload predecessor left raw/altscreen modes active. If this successor
		// is signalled before adoption, no runtime exists to restore them.
		restoreFailedReloadTerminal();
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

// Pi is already running while optional artifact validation scans the package.
const bundleExists = await stat(bundlePath).then(() => true, () => false);
const bundleFresh = bundleExists && (forceBundle || (useBundle && await bundleIsFresh()));
if (useBundle && bundleExists && !forceBundle && !bundleFresh) {
	process.stderr.write("[sumocode] host bundle stale — using source; run pnpm build:host\n");
}

let mod;
try {
	if (forceBundle && !bundleExists) {
		throw new Error(`[sumocode] forced host bundle is missing: ${bundlePath}`);
	}
	if (bundleFresh) {
		try {
			const bundledModule = await import(pathToFileURL(bundlePath).href);
			if (typeof bundledModule.main !== "function") {
				throw new Error("host bundle does not export main()");
			}
			// Revalidate after loading: a concurrent build or source edit could have
			// changed inputs or replaced the bundle between the freshness check and
			// this import. Re-run the FULL freshness check (inputs + outputs); if the
			// on-disk state no longer matches, discard the bundle and use source
			// rather than run a generation never covered by a passing freshness result.
			if (!forceBundle && !(await bundleIsFresh())) {
				throw new Error("host bundle changed during import");
			}
			mod = bundledModule;
		} catch (error) {
			if (forceBundle) {
				throw new Error(`[sumocode] forced host bundle failed to import: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
			process.stderr.write(`[sumocode] host bundle unusable — using source: ${error instanceof Error ? error.message : String(error)}\n`);
			mod = await importSourceHost();
		}
	} else {
		mod = await importSourceHost();
	}
} catch (error) {
	await terminateUnadoptedChild();
	releasePreAdoptionSignalHandlers();
	restoreFailedReloadTerminal();
	throw error;
}

// Integration-only seam that widens the otherwise sub-millisecond import-tail
// window so a PTY signal can land between import and adoption; inert in prod.
const preMainTestDelayMs = process.env.NODE_ENV === "test"
	? Number.parseInt(process.env.SUMOCODE_TEST_PRE_MAIN_DELAY_MS ?? "0", 10)
	: 0;
if (Number.isFinite(preMainTestDelayMs) && preMainTestDelayMs > 0) {
	await new Promise((resolve) => setTimeout(resolve, preMainTestDelayMs));
}

// An early SIGINT/SIGTERM may have begun tearing down the pre-spawned child
// during import. Never adopt it or enter the retained runtime/altscreen once
// cleanup has started; the early handler owns the child reap and process exit.
if (relayingEarlySignal) {
	await earlyCleanupPromise;
	process.exit(0);
}

let childAdopted = false;
try {
	await mod.main({
		preSpawnedChild,
		onPreSpawnedChildAdopted: () => {
			childAdopted = true;
			releasePreAdoptionSignalHandlers();
		},
		env: {
			...process.env,
			SUMOCODE_ROOT_DIR: root,
			SUMOCODE_PROJECT_CWD: process.env.SUMOCODE_PROJECT_CWD ?? process.cwd(),
		},
		shouldAbortAdoption: () => relayingEarlySignal,
	});
} catch (error) {
	// main() can reject before SumoRpcClient adopts the pre-spawned child
	// (Yoga/config/runtime initialization). The entry still owns it then, and a
	// reload predecessor may have deliberately left terminal modes active.
	await terminateUnadoptedChild();
	if (!childAdopted) restoreFailedReloadTerminal();
	throw error;
} finally {
	// When an early signal is relaying (e.g. main() aborted adoption while the
	// SIGTERM-ignoring child is still in its reap grace), keep the guarded entry
	// handlers installed: relayEarlySignal's own cleanup releases them after the
	// reap and then exits, so a repeated signal stays suppressed instead of
	// hitting Node's default disposition mid-cleanup.
	if (!relayingEarlySignal) releasePreAdoptionSignalHandlers();
}
