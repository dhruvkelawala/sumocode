import { join } from "node:path";

/**
 * Native-runtime resolution seam (plan 117).
 *
 * The compiled binary's entry sets SUMOCODE_NATIVE_DIR to the real directory
 * of process.execPath before importing any host code. Nothing here inspects
 * Bun globals, so the exact same code runs under Node (dev) and Bun (native):
 * on Node the env is unset and every resolver takes its source fallback.
 */

const NATIVE_DIR_ENV_KEY = "SUMOCODE_NATIVE_DIR";

/**
 * Directory override for sidecar assets, taking precedence over the native
 * dir. Exists so contract tests can redirect asset lookups without a full
 * archive layout on disk.
 */
export const ASSET_DIR_OVERRIDE_ENV_KEY = "SUMOCODE_ASSET_DIR";

/** Real archive dir when running inside the compiled binary, else null. */
export function resolveNativeDir(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env[NATIVE_DIR_ENV_KEY];
	if (raw === undefined) return null;
	const trimmed = raw.trim();
	return trimmed === "" ? null : trimmed;
}

/** True when host code is executing inside the compiled binary. */
export function isNativeRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveNativeDir(env) !== null;
}

/**
 * Resolution order for sidecar assets: explicit env override dir → native
 * archive `share/` dir → caller-supplied dev/source path. `devPath` may be a
 * thunk so Node-only resolution (require.resolve on package paths that do not
 * exist inside the compiled binary) never runs in native mode.
 */
export function resolveAsset(
	name: string,
	devPath: string | (() => string),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env[ASSET_DIR_OVERRIDE_ENV_KEY];
	if (override !== undefined && override.trim() !== "") return join(override, name);
	const nativeDir = resolveNativeDir(env);
	if (nativeDir !== null) return join(nativeDir, "share", name);
	return typeof devPath === "function" ? devPath() : devPath;
}
