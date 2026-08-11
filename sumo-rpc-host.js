import { spawn } from "node:child_process";
import { createJiti } from "jiti";
import { buildChildSpawnPlan } from "./src/sumo-tui/rpc/spawn-child.mjs";

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

const jiti = createJiti(import.meta.url, {
	moduleCache: true,
	tryNative: false,
});

const PRE_ADOPTION_KILL_GRACE_MS = 250;

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

let relayingEarlySignal = false;
const handleEarlySigint = () => relayEarlySignal("SIGINT");
const handleEarlySigterm = () => relayEarlySignal("SIGTERM");

function releasePreAdoptionSignalHandlers() {
	process.removeListener("SIGINT", handleEarlySigint);
	process.removeListener("SIGTERM", handleEarlySigterm);
}

function relayEarlySignal(signal) {
	if (relayingEarlySignal) return;
	relayingEarlySignal = true;
	releasePreAdoptionSignalHandlers();
	void terminateUnadoptedChild().finally(() => {
		// Installing a signal listener suppresses Node's default termination.
		// Restore it only after bounded SIGKILL escalation has reaped the child.
		process.kill(process.pid, signal);
	});
}

if (preSpawnedChild) {
	process.once("SIGINT", handleEarlySigint);
	process.once("SIGTERM", handleEarlySigterm);
}

let mod;
try {
	mod = await jiti.import("./src/sumo-tui/rpc/host.ts");
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
