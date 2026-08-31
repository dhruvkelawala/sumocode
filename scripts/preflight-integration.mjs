#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	extensionInputManifestIsFresh,
	extensionOutputsHash,
} from "./lib/extension-bundle.mjs";
import {
	hostInputManifestIsFresh,
	hostOutputsHash,
} from "./lib/host-bundle.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HARNESS_SIGNATURE = "sumocode-verification-harness-v2";
const HARNESS_DIR_PREFIXES = ["sumocode-harness-v2-", "sumocode-fake-pi-"];

function processRows() {
	const output = execFileSync("ps", ["eww", "-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" });
	return output.split("\n").flatMap((line) => {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
	});
}

function isHarnessProcess(row) {
	return row.pid !== process.pid && (
		row.command.includes(`SUMOCODE_HARNESS_SIGNATURE=${HARNESS_SIGNATURE}`)
		|| /(?:^|\/)sumocode-fake-pi-[A-Za-z0-9._-]+(?:\/|\s|$)/.test(row.command)
	);
}

export async function onlyHarnessScriptPackageDrift(root, manifest, manifestPath) {
	if (!Array.isArray(manifest.inputs) || !manifest.inputs.includes("package.json")) return false;
	let baselineCommit;
	try {
		baselineCommit = execFileSync("git", ["log", "-1", "--format=%H", "--", relative(root, manifestPath)], { cwd: root, encoding: "utf8" }).trim();
	} catch { return false; }
	if (!baselineCommit) return false;
	let changed;
	try {
		changed = execFileSync("git", ["diff", "--name-only", baselineCommit, "--", ...manifest.inputs], { cwd: root, encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch { return false; }
	if (changed.length !== 1 || changed[0] !== "package.json") return false;
	try {
		const currentPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		const baselinePackage = JSON.parse(execFileSync("git", ["show", `${baselineCommit}:package.json`], { cwd: root, encoding: "utf8" }));
		delete currentPackage.scripts;
		delete baselinePackage.scripts;
		return JSON.stringify(currentPackage) === JSON.stringify(baselinePackage);
	} catch { return false; }
}

async function artifactIssue(root, kind) {
	const manifestPath = join(root, "dist", kind, ".inputs.json");
	if (!existsSync(manifestPath)) {
		if (kind === "host") return undefined;
		return {
			code: "stale-dist-extension",
			message: "dist/extension has no .inputs.json manifest",
			remediation: "run pnpm build:extension",
		};
	}
	try {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const inputsFresh = kind === "host"
			? await hostInputManifestIsFresh(root, manifest)
			: await extensionInputManifestIsFresh(root, manifest);
		const harnessScriptOnlyDrift = !inputsFresh && kind === "extension"
			? await onlyHarnessScriptPackageDrift(root, manifest, manifestPath)
			: false;
		const outputsHash = kind === "host" ? await hostOutputsHash(root) : await extensionOutputsHash(root);
		if ((inputsFresh || harnessScriptOnlyDrift) && outputsHash === manifest.outputsHash) return undefined;
	} catch {
		// Named below with the same deterministic remediation.
	}
	return {
		code: `stale-dist-${kind}`,
		message: `dist/${kind} does not match its .inputs.json manifest`,
		remediation: `run pnpm build:${kind}`,
	};
}

async function nodeModulesIssue(root) {
	const path = join(root, "node_modules");
	if (!existsSync(path)) return { code: "node-modules-missing", message: "node_modules is missing", remediation: "run pnpm install --frozen-lockfile" };
	const info = await lstat(path);
	if (!info.isSymbolicLink()) return undefined;
	const target = await realpath(path);
	const targetRelative = relative(root, target);
	if (targetRelative !== "node_modules" && (targetRelative === ".." || targetRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) {
		return {
			code: "node-modules-symlink-drift",
			message: `node_modules symlink resolves outside this worktree: ${target}`,
			remediation: "replace the cross-worktree symlink with pnpm install --frozen-lockfile in this worktree",
		};
	}
	return undefined;
}

async function staleHarnessDirs(tempRoot) {
	let entries = [];
	try { entries = await readdir(tempRoot, { withFileTypes: true }); } catch { return []; }
	return entries
		.filter((entry) => entry.isDirectory() && HARNESS_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
		.map((entry) => join(tempRoot, entry.name));
}

export async function inspectIntegrationPreflight({ root = ROOT, tempRoot = tmpdir(), rows = processRows(), env = process.env } = {}) {
	const issues = [];
	const notices = [];
	const orphanRows = rows.filter(isHarnessProcess);
	if (orphanRows.length > 0) {
		issues.push({
			code: "orphan-harness-children",
			message: `harness-owned children are still alive: ${orphanRows.map((row) => `${row.pid} (${row.command.slice(0, 160)})`).join(", ")}`,
			remediation: "run node scripts/preflight-integration.mjs --fix",
			rows: orphanRows,
		});
	}
	const staleDirs = await staleHarnessDirs(tempRoot);
	if (staleDirs.length > 0) {
		issues.push({
			code: "stale-harness-state",
			message: `stale harness locks/state: ${staleDirs.join(", ")}`,
			remediation: "run node scripts/preflight-integration.mjs --fix",
			paths: staleDirs,
		});
	}
	const modules = await nodeModulesIssue(root);
	if (modules) issues.push(modules);
	for (const kind of ["host", "extension"]) {
		const issue = await artifactIssue(root, kind);
		if (issue) issues.push(issue);
	}
	if (env.NODE_PATH) notices.push(`inherited NODE_PATH will be stripped: ${env.NODE_PATH}`);
	if (env.NODE_COMPILE_CACHE) notices.push(`inherited NODE_COMPILE_CACHE will be replaced: ${env.NODE_COMPILE_CACHE}`);
	for (const key of Object.keys(env).filter((key) => key.startsWith("HERDR_") || key.startsWith("PI_SESSION"))) {
		notices.push(`inherited ${key} will be stripped`);
	}
	return { issues, notices };
}

async function fixSafeIssues(report) {
	const orphanIssue = report.issues.find((issue) => issue.code === "orphan-harness-children");
	for (const row of orphanIssue?.rows ?? []) {
		try { process.kill(-row.pgid, "SIGTERM"); } catch {}
	}
	if ((orphanIssue?.rows ?? []).length > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
	for (const row of orphanIssue?.rows ?? []) {
		try { process.kill(-row.pgid, "SIGKILL"); } catch {}
	}
	const stateIssue = report.issues.find((issue) => issue.code === "stale-harness-state");
	for (const path of stateIssue?.paths ?? []) await rm(path, { recursive: true, force: true });
}

export async function runIntegrationPreflight({ fix = false } = {}) {
	let report = await inspectIntegrationPreflight();
	if (fix) {
		await fixSafeIssues(report);
		report = await inspectIntegrationPreflight();
	}
	for (const notice of report.notices) process.stdout.write(`[integration preflight] contained: ${notice}\n`);
	if (report.issues.length === 0) {
		process.stdout.write("[integration preflight] clean\n");
		return true;
	}
	for (const issue of report.issues) {
		process.stderr.write(`[integration preflight] ${issue.code}: ${issue.message}\n  remediation: ${issue.remediation}\n`);
	}
	return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const unknown = process.argv.slice(2).filter((arg) => arg !== "--fix");
	if (unknown.length > 0) {
		process.stderr.write(`unknown preflight option: ${unknown.join(" ")}\n`);
		process.exitCode = 2;
	} else if (!await runIntegrationPreflight({ fix: process.argv.includes("--fix") })) {
		process.exitCode = 1;
	}
}
