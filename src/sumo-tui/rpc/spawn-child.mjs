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

const EXTENSION_INPUTS = [
	"src/assets/sumo-face.ans",
	"src/background-tasks/bounded-terminal-runner.mjs",
	"scripts/build-extension.mjs",
	"scripts/lib/extension-bundle.mjs",
	"tsconfig.json",
	"pnpm-lock.yaml",
];

const EXTENSION_OUTPUTS = [
	"sumocode-extension.bundle.mjs",
	"sumocode-extension.bundle.mjs.map",
	"assets/sumo-face.ans",
	"bounded-terminal-runner.mjs",
];

export function normalizeHashPath(path) {
	return path.replaceAll("\\", "/");
}

function contentHash(base, files) {
	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(normalizeHashPath(relative(base, path)));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

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
	files.push(...EXTENSION_INPUTS.map((input) => resolve(root, input)));
	files.sort((left, right) => {
		const leftPath = normalizeHashPath(relative(root, left));
		const rightPath = normalizeHashPath(relative(root, right));
		return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
	});

	return contentHash(root, files);
}

export function extensionOutputsHash(root) {
	const outDir = resolve(root, "dist/extension");
	return contentHash(outDir, EXTENSION_OUTPUTS.map((output) => resolve(outDir, output)));
}

function hasFreshExtensionBundle(root, bundle) {
	const inputsSidecar = resolve(root, "dist/extension/.inputs-hash");
	const outputsSidecar = resolve(root, "dist/extension/.outputs-hash");
	if (!existsSync(bundle) || !existsSync(inputsSidecar) || !existsSync(outputsSidecar)) return false;
	try {
		return readFileSync(inputsSidecar, "utf8").trim() === extensionInputsHash(root)
			&& readFileSync(outputsSidecar, "utf8").trim() === extensionOutputsHash(root);
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
