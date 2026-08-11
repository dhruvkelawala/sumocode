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
	mod = await jiti.import("./src/sumo-tui/rpc/host.ts");
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
