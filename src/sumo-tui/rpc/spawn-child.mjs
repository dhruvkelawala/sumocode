import { existsSync, readdirSync, statSync } from "node:fs";
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

function newestExtensionSourceMtime(root) {
	let newest = 0;
	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
				newest = Math.max(newest, statSync(path).mtimeMs);
			}
		}
	}
	try {
		visit(resolve(root, "src"));
	} catch {
		return Number.POSITIVE_INFINITY;
	}
	return newest;
}

function extensionEntry(root, env) {
	const source = resolve(root, "src/extension.ts");
	if (env.SUMOCODE_EXTENSION_BUNDLE === "0") return source;
	const bundle = resolve(root, "dist/extension/sumocode-extension.bundle.mjs");
	try {
		if (existsSync(bundle) && statSync(bundle).mtimeMs >= newestExtensionSourceMtime(root)) return bundle;
	} catch {}
	return source;
}

/**
 * Builds the exact child-process invocation shared by the native entry point
 * and the jiti-loaded host. Keeping this in plain JavaScript lets the entry
 * point pre-spawn Pi before importing the TypeScript host runtime.
 */
export function buildChildSpawnPlan(env, argv) {
	if (!env.PI_BIN) return undefined;
	const root = hostRoot(env);
	return {
		command: env.PI_BIN,
		args: ["--mode", "rpc", "-e", extensionEntry(root, env), ...argv],
		cwd: hostCwd(env),
		env: childEnv(env),
	};
}
