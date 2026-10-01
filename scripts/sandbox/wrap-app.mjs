import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Pi 0.99.1 uses PI_CODING_AGENT_DIR/trust.json, not XDG_CONFIG_HOME.
// Approve only the owned test checkout; never copy the developer's trust store.
export function createTestAgentDir(tempDir, cwd) {
	const agentDir = mkdtempSync(join(tempDir, "sumocode-test-agent-"));
	writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [realpathSync(cwd)]: true })}\n`, { mode: 0o600 });
	return agentDir;
}

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
	const ps = join(state, "bin/ps");
	const psStat = lstatSync(ps);
	if (!psStat.isFile() || (psStat.mode & 0o6000) !== 0 || (psStat.mode & 0o111) === 0) {
		throw new Error("create and re-sign the worktree-local non-setuid ps first");
	}
	const tempDir = env.TMPDIR ?? process.env.TMPDIR;
	// Pi may create an explicitly owned agent leaf at startup. Validate its
	// nearest existing ancestor, including symlink resolution, without creating it.
	let agentAncestor = env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : undefined;
	while (agentAncestor && !existsSync(agentAncestor)) agentAncestor = dirname(agentAncestor);
	for (const path of [cwd, tempDir, ...(agentAncestor ? [agentAncestor] : [])]) {
		if (!path) throw new Error("sandboxed app requires an owned TMPDIR");
		const within = relative(realpathSync(root), realpathSync(path));
		if (within === ".." || within.startsWith("../") || isAbsolute(within)) {
			throw new Error("sandboxed app cwd, TMPDIR and agent directory must be inside this worktree");
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
	const childEnv = { ...env, TMPDIR: state, SUMOCODE_TEST_SANDBOX: mode, CLAUDE_CODE_TMPDIR: tempDir, NODE_USE_ENV_PROXY: "1",
		PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR || createTestAgentDir(tempDir, cwd) };
	delete childEnv.SUMOCODE_TEST_PS_BIN;
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) delete childEnv[key];
	return {
		command: "/usr/bin/env",
		// srt itself must stay outside: it owns the proxies and sandbox-exec.
		// Clear srt's injected NO_PROXY only INSIDE, before Node initializes fetch.
		args: [`TMPDIR=${state}`, process.execPath, join(srt, "dist/cli.js"), "--settings", settingsPath, "--", "/usr/bin/env", "NO_PROXY=", "no_proxy=", `PATH=${join(state, "bin")}:${env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`, `SUMOCODE_TEST_PS_BIN=${ps}`, command, ...args],
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
