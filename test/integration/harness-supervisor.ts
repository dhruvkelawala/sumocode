import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll } from "vitest";
import { HARNESS_SIGNATURE, HARNESS_SIGNATURE_ENV_KEY } from "../../scripts/lib/integration-harness-constants.mjs";

export { HARNESS_SIGNATURE, HARNESS_SIGNATURE_ENV_KEY };

/**
 * Cross-file harness contract: this module and scripts/run-integration-harness.mjs write owner.json
 * (`pid`, `startedAt`, optional `root`/`mode`) and evidence-retained.json (`ownerPid`, `retainedAt`,
 * optional `reason`); scripts/preflight-integration.mjs consumes those files. TERM→KILL grace is
 * owned by SUPERVISOR_TERM_GRACE_MS here, RUNNER_TERM_GRACE_MS in the runner, and
 * PREFLIGHT_TERM_GRACE_MS in preflight.
 */
const SUPERVISOR_TERM_GRACE_MS = 750;
const STDERR_TAIL_BYTES = 64 * 1024;

export type ReadinessState = "boot" | "input" | "app";

export const READINESS_EVENT_BY_STATE = {
	boot: "boot_screen_frame",
	input: "input_ready",
	app: "app_ready",
} as const satisfies Record<ReadinessState, string>;

export interface TimeoutEvidenceInput {
	readonly evidenceDir: string;
	readonly argv: readonly string[];
	readonly stderrPath: string;
	readonly diagPath: string;
	readonly output: string;
	readonly finalScreen: string;
}

export interface ChildEvidenceContext {
	readonly evidenceDir: string;
	readonly stderrPath: string;
	readonly diagPath: string;
	readonly argv: readonly string[];
}

interface HarnessManifestEvent {
	readonly event: "spawn" | "exit" | "reaped";
	readonly pid: number;
	readonly pgid: number;
	readonly argv?: readonly string[];
	readonly evidenceDir?: string;
	readonly kind?: "pty";
	readonly code?: number | null;
	readonly signal?: string | number | null;
}

interface DiagnosticReadinessEvent {
	readonly event: string;
}

export interface SupervisedProcess {
	readonly child: ChildProcess;
	readonly pid: number;
	readonly pgid: number;
	readonly evidence: ChildEvidenceContext;
	terminate(): Promise<void>;
	shouldCaptureExitFailure(hasPendingWaiters: boolean): boolean;
	captureFailure(output?: string, finalScreen?: string): Promise<string>;
}

let fallbackRoot: string | undefined;
let childSequence = 0;
const focusedProcessGroups = new Set<number>();

function harnessRoot(env: NodeJS.ProcessEnv = process.env): string {
	if (env.SUMOCODE_INTEGRATION_RUN_ROOT) return env.SUMOCODE_INTEGRATION_RUN_ROOT;
	if (fallbackRoot === undefined) {
		fallbackRoot = mkdtempSync(join(tmpdir(), "sumocode-harness-v2-focused-"));
		writeFileSync(
			join(fallbackRoot, "owner.json"),
			`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode: "focused" }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	}
	return fallbackRoot;
}

function manifestPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.SUMOCODE_INTEGRATION_MANIFEST ?? join(harnessRoot(env), "children.jsonl");
}

function appendManifest(event: HarnessManifestEvent, env: NodeJS.ProcessEnv = process.env): void {
	const path = manifestPath(env);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, { mode: 0o600 });
	if (env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined && event.event === "spawn") focusedProcessGroups.add(event.pgid);
}

function shellArg(value: string): string {
	if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function childLabel(argv: readonly string[]): string {
	const command = basename(argv[0] ?? "child").replaceAll(/[^A-Za-z0-9_.-]/g, "-");
	return `${String(++childSequence).padStart(3, "0")}-${command}`;
}

export function createChildEvidenceContext(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	diagPath?: string,
): ChildEvidenceContext {
	const root = harnessRoot(env);
	if (env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined) {
		const tempRoot = join(root, "tmp");
		mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
		env.TMPDIR = tempRoot;
	}
	const evidenceDir = join(root, "evidence", `worker-${process.pid}`, childLabel(argv));
	mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
	return {
		evidenceDir,
		stderrPath: join(evidenceDir, "stderr.log"),
		diagPath: diagPath ?? join(evidenceDir, "diagnostics-live.jsonl"),
		argv,
	};
}

function groupIsAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (groupIsAlive(pgid) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	return !groupIsAlive(pgid);
}

async function terminateGroup(pgid: number): Promise<void> {
	if (!groupIsAlive(pgid)) return;
	try { process.kill(-pgid, "SIGTERM"); } catch { return; }
	if (await waitForGroupExit(pgid, SUPERVISOR_TERM_GRACE_MS)) return;
	try { process.kill(-pgid, "SIGKILL"); } catch { return; }
	await waitForGroupExit(pgid, SUPERVISOR_TERM_GRACE_MS);
}

function readTail(path: string): string {
	if (!existsSync(path)) return "<no stderr captured>\n";
	const bytes = readFileSync(path);
	return bytes.subarray(Math.max(0, bytes.length - STDERR_TAIL_BYTES)).toString("utf8");
}

function runRootForEvidence(evidenceDir: string): string | undefined {
	let path = evidenceDir;
	for (;;) {
		if (basename(path) === "evidence") return dirname(path);
		const parent = dirname(path);
		if (parent === path) return undefined;
		path = parent;
	}
}

function markRunEvidenceRetained(root: string): void {
	writeFileSync(
		join(root, "evidence-retained.json"),
		`${JSON.stringify({ ownerPid: process.pid, retainedAt: new Date().toISOString() }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

function markEvidenceRetained(evidenceDir: string): void {
	const root = runRootForEvidence(evidenceDir);
	if (root !== undefined) markRunEvidenceRetained(root);
}

export async function captureTimeoutEvidence(input: TimeoutEvidenceInput): Promise<string> {
	await mkdir(input.evidenceDir, { recursive: true, mode: 0o700 });
	await Promise.all([
		writeFile(join(input.evidenceDir, "argv.txt"), `${input.argv.map(shellArg).join(" ")}\n`, { mode: 0o600 }),
		writeFile(join(input.evidenceDir, "stderr-tail.txt"), readTail(input.stderrPath), { mode: 0o600 }),
		writeFile(join(input.evidenceDir, "raw-output.txt"), input.output, { mode: 0o600 }),
		writeFile(join(input.evidenceDir, "final-screen.txt"), input.finalScreen, { mode: 0o600 }),
		existsSync(input.diagPath)
			? copyFile(input.diagPath, join(input.evidenceDir, "diagnostics.jsonl"))
			: writeFile(join(input.evidenceDir, "diagnostics.jsonl"), "<no diagnostics captured>\n", { mode: 0o600 }),
	]);
	markEvidenceRetained(input.evidenceDir);
	return input.evidenceDir;
}

export async function waitForDiagnosticReadiness(diagPath: string, state: ReadinessState, timeoutMs: number): Promise<DiagnosticReadinessEvent> {
	const expected = READINESS_EVENT_BY_STATE[state];
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (existsSync(diagPath)) {
			const lines = await readFile(diagPath, "utf8");
			for (const line of lines.split("\n")) {
				if (!line.trim()) continue;
				try {
					// SAFETY: readiness consumes only the string `event` discriminator; all other diagnostic fields are ignored.
					const event = JSON.parse(line) as DiagnosticReadinessEvent;
					if (event.event === expected) return event;
				} catch {
					// The final JSONL write may be in flight; retry the state predicate.
				}
			}
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for diagnostic readiness ${state} (${expected})`);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

export function spawnSupervisedProcess(command: string, args: readonly string[], options: SpawnOptions = {}): SupervisedProcess {
	const env = { ...options.env, [HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE };
	const evidence = createChildEvidenceContext([command, ...args], env);
	const child = spawn(command, [...args], { ...options, detached: true, env });
	if (child.pid === undefined) throw new Error(`supervised child did not publish a pid: ${command}`);
	const pid = child.pid;
	const pgid = pid;
	appendManifest({ event: "spawn", pid, pgid, argv: [command, ...args], evidenceDir: evidence.evidenceDir }, env);
	child.stderr?.on("data", (chunk: Buffer | string) => appendFileSync(evidence.stderrPath, chunk));
	const exited = new Promise<void>((resolveExit) => child.once("exit", (code, signal) => {
		appendManifest({ event: "exit", pid, pgid, code, signal }, env);
		resolveExit();
	}));
	let reaping: Promise<void> | undefined;
	let terminationExpected = false;
	return {
		child,
		pid,
		pgid,
		evidence,
		terminate(): Promise<void> {
			terminationExpected = true;
			reaping ??= (async () => {
				// Let spawn complete its setsid before addressing the new group.
				await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
				await terminateGroup(pgid);
				if (child.exitCode === null && child.signalCode === null) {
					try { child.kill("SIGKILL"); } catch { /* child exited at the boundary */ }
				}
				await Promise.race([exited, new Promise<void>((resolveDelay) => setTimeout(resolveDelay, SUPERVISOR_TERM_GRACE_MS))]);
				appendManifest({ event: "reaped", pid, pgid }, env);
			})();
			return reaping;
		},
		shouldCaptureExitFailure(hasPendingWaiters: boolean): boolean {
			return !terminationExpected || hasPendingWaiters;
		},
		captureFailure(output = "", finalScreen = ""): Promise<string> {
			return captureTimeoutEvidence({ ...evidence, output, finalScreen });
		},
	};
}

export function supervisePtyProcess(pid: number, evidence: ChildEvidenceContext, env: NodeJS.ProcessEnv): Pick<SupervisedProcess, "pid" | "pgid" | "evidence" | "terminate" | "captureFailure"> {
	const pgid = pid;
	let reaping: Promise<void> | undefined;
	env[HARNESS_SIGNATURE_ENV_KEY] = HARNESS_SIGNATURE;
	appendManifest({ event: "spawn", pid, pgid, argv: evidence.argv, evidenceDir: evidence.evidenceDir, kind: "pty" }, env);
	return {
		pid,
		pgid,
		evidence,
		terminate(): Promise<void> {
			reaping ??= terminateGroup(pgid).then(() => appendManifest({ event: "reaped", pid, pgid }, env));
			return reaping;
		},
		captureFailure(output = "", finalScreen = ""): Promise<string> {
			return captureTimeoutEvidence({ ...evidence, output, finalScreen });
		},
	};
}

export function recordPtyExit(pid: number, pgid: number, exitCode: number, signal: number | undefined, env: NodeJS.ProcessEnv): void {
	appendManifest({ event: "exit", pid, pgid, code: exitCode, signal, kind: "pty" }, env);
}

// Register at import time so every focused Vitest file that imports this seam gets a final
// process-group audit, even when a test fails before it can register its own cleanup hook.
afterAll(async () => {
	if (fallbackRoot === undefined) return;
	const root = fallbackRoot;
	const survivors = [...focusedProcessGroups].filter(groupIsAlive);
	for (const pgid of survivors) await terminateGroup(pgid);
	const unreaped = survivors.filter(groupIsAlive);
	process.stdout.write(`[focused harness] zero-survivor audit: ${survivors.length} survivors across ${focusedProcessGroups.size} registered process group(s)\n`);
	if (survivors.length > 0) markRunEvidenceRetained(root);
	if (!existsSync(join(root, "evidence-retained.json"))) rmSync(root, { recursive: true, force: true });
	fallbackRoot = undefined;
	focusedProcessGroups.clear();
	if (survivors.length > 0) {
		throw new Error(`focused harness leaked ${survivors.length} process group(s); ${unreaped.length} remained after TERM→KILL`);
	}
});
