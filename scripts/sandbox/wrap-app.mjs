import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Test-only: the trusted runner supplies owned paths and exact fixture ports.
export function wrapTestApp(command, args, { env = process.env, cwd = process.cwd(), ports = [] } = {}) {
	const mode = process.env.SUMOCODE_TEST_SANDBOX;
	if (!mode) return { command, args: [...args], env };
	if (mode !== "srt") throw new Error(`unsupported test sandbox: ${mode}`);
	if (process.platform !== "darwin") throw new Error("srt app spike is macOS-only; Linux is not verified");
	const state = join(root, ".srt-spike");
	const srt = join(state, "tooling/node_modules/@anthropic-ai/sandbox-runtime");
	if (JSON.parse(readFileSync(join(srt, "package.json"), "utf8")).version !== "0.0.78") {
		throw new Error("install worktree-local srt 0.0.78 first");
	}
	const tempDir = env.TMPDIR ?? process.env.TMPDIR;
	for (const path of [cwd, tempDir]) {
		if (!path) throw new Error("sandboxed app requires an owned TMPDIR");
		const within = relative(realpathSync(root), realpathSync(path));
		if (within === ".." || within.startsWith("../") || isAbsolute(within)) {
			throw new Error("sandboxed app cwd and TMPDIR must be inside this worktree");
		}
	}
	for (const port of ports) {
		if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 7749) throw new Error("invalid fixture port");
	}
	const settings = JSON.parse(readFileSync(join(root, "scripts/sandbox/srt-tests.json"), "utf8"));
	for (const key of ["allowRead", "allowWrite", "denyWrite"]) {
		settings.filesystem[key] = settings.filesystem[key].map((path) => path.startsWith("~") || isAbsolute(path) ? path : resolve(root, path));
	}
	settings.network.allowedDomains = [...new Set(ports)].flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`]);
	mkdirSync(join(state, "settings"), { recursive: true, mode: 0o700 });
	const directory = mkdtempSync(join(state, "settings/app-"));
	const settingsPath = join(directory, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	// srt's own AF_UNIX backend needs a short absolute path on Darwin.
	// CLAUDE_CODE_TMPDIR restores the run-owned temp path INSIDE the app.
	const childEnv = { ...env, TMPDIR: state, SUMOCODE_TEST_SANDBOX: mode, CLAUDE_CODE_TMPDIR: tempDir, NODE_USE_ENV_PROXY: "1" };
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) delete childEnv[key];
	return {
		command: "/usr/bin/env",
		// srt itself must stay outside: it owns the proxies and sandbox-exec.
		// Clear srt's injected NO_PROXY only INSIDE, before Node initializes fetch.
		args: [`TMPDIR=${state}`, process.execPath, join(srt, "dist/cli.js"), "--settings", settingsPath, "--", "/usr/bin/env", "NO_PROXY=", "no_proxy=", command, ...args],
		env: childEnv,
	};
}

export function spawnTestAppSync(command, args, options = {}) {
	const app = wrapTestApp(command, args, options);
	return spawnSync(app.command, app.args, { ...options, env: app.env });
}

export function execTestAppSync(command, args, options = {}) {
	const app = wrapTestApp(command, args, options);
	return execFileSync(app.command, app.args, { ...options, env: app.env });
}
