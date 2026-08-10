import { resolve } from "node:path";

function hostRoot(env) {
	return resolve(env.SUMOCODE_ROOT_DIR ?? process.cwd());
}

function hostCwd(env) {
	return resolve(env.SUMOCODE_PROJECT_CWD ?? process.cwd());
}

function childEnv(env) {
	return {
		...env,
		SUMOCODE_RPC_CHILD: "1",
		SUMO_TUI: "0",
	};
}

/**
 * Builds the exact child-process invocation shared by the native entry point
 * and the jiti-loaded host. Keeping this in plain JavaScript lets the entry
 * point pre-spawn Pi before importing the TypeScript host runtime.
 */
export function buildChildSpawnPlan(env, argv) {
	if (!env.PI_BIN) return undefined;
	return {
		command: env.PI_BIN,
		args: ["--mode", "rpc", "-e", resolve(hostRoot(env), "src/extension.ts"), ...argv],
		cwd: hostCwd(env),
		env: childEnv(env),
	};
}
