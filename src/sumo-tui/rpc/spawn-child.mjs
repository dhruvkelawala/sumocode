import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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

const EXTENSION_ASSETS = [
	"src/assets/sumo-face.ans",
	"src/background-tasks/bounded-terminal-runner.mjs",
];

export function extensionInputsHash(root) {
	const files = [];
	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
				files.push(path);
			}
		}
	}
	visit(resolve(root, "src"));
	files.push(...EXTENSION_ASSETS.map((asset) => resolve(root, asset)));
	files.sort((left, right) => left.localeCompare(right));

	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(relative(root, path));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function hasFreshExtensionBundle(root, bundle) {
	const sidecar = resolve(root, "dist/extension/.inputs-hash");
	if (!existsSync(bundle) || !existsSync(sidecar)) return false;
	try {
		return readFileSync(sidecar, "utf8").trim() === extensionInputsHash(root);
	} catch {
		return false;
	}
}

function extensionEntry(root, env) {
	const source = resolve(root, "src/extension.ts");
	if (env.SUMOCODE_EXTENSION_BUNDLE === "0") return source;
	const bundle = resolve(root, "dist/extension/sumocode-extension.bundle.mjs");
	if (hasFreshExtensionBundle(root, bundle)) return bundle;
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
