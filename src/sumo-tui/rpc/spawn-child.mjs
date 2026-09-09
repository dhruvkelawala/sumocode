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

function isNativeRuntime(env) {
	// Set by the compiled binary's entry (src/native/main.ts) before any host
	// code loads; src/native/paths.ts shares this exact marker.
	return Boolean(env.SUMOCODE_NATIVE_DIR);
}

function extensionEntry(root, env) {
	if (isNativeRuntime(env)) {
		// The native archive is immutable and ships a dedicated lean child entry;
		// direct Pi uses the separate canonical bundle.
		return resolve(root, "extension/sumocode-rpc-extension.bundle.mjs");
	}
	if (env.SUMOCODE_EXTENSION_BUNDLE === "0") return resolve(root, "src/rpc-child-extension.ts");
	// Route through the stable shim even when a generated bundle is fresh.
	// The shim validates content, imports the bundle, and can retry source when
	// native resolution of an external peer fails inside the actual Pi child.
	return resolve(root, "src/extension-entry.ts");
}

/**
 * Builds the exact child-process invocation shared by the native entry point
 * and the jiti-loaded host. Keeping this in plain JavaScript lets the entry
 * point pre-spawn Pi before importing the TypeScript host runtime.
 */
export function buildChildSpawnPlan(env, argv, defaultPiBin) {
	const command = env.PI_BIN || defaultPiBin;
	if (!command) return undefined;
	const root = hostRoot(env);
	return {
		command,
		args: ["--mode", "rpc", "-e", extensionEntry(root, env), ...argv],
		cwd: hostCwd(env),
		env: childEnv(env),
	};
}
