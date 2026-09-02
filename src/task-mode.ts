/**
 * Task mode auto-exit.
 *
 * When SumoCode launches via `sumocode task "<prompt>"` (i.e.
 * `SUMOCODE_TASK_MODE=1`), the session is a hand-off from an orchestrator:
 * do one delegated turn, then shut down the child process. This module wires
 * the lifecycle that exits the agent while leaving the terminal pane itself as
 * a preserved viewport the orchestrator/human can inspect.
 *
 * Behavior:
 *
 * - On each `agent_end`, write the latest assistant response for the parent.
 * - Every `agent_end` (re)arms a silence countdown (default 30s): when a full
 *   window passes with no turn running and no interactive input, the child
 *   shuts down. `agent_start` and interactive typing cancel the pending
 *   countdown; the next `agent_end` re-arms. A child therefore always exits
 *   after it goes quiet — steering or takeover can never pin it open forever.
 * - While the countdown runs, a footer status entry counts down
 *   ("task done · exiting in 9s · type or steer to extend").
 * - Opt out entirely with `SUMOCODE_TASK_KEEP_OPEN=1`.
 *
 * Shutdown uses Pi's `ctx.shutdown()`: task completion belongs to the child
 * process lifecycle, while pane close is an explicit orchestrator/user decision
 * (for example subagent cancellation).
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	assertArtifactInsideDir,
	assertPrivateArtifact,
	assertPrivateDir,
	isErrnoCode,
	type PrivateArtifactFs,
	nodeArtifactFs,
	validatedArtifactStat,
	PRIVATE_FILE_MODE,
} from "./private-artifact.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Marker-file env vars set by the visible-subagent spawn pipeline. They
 * are a contract between the orchestrator and THIS process only: if they leak
 * to subprocesses (bash tool commands, integration-test PTY children, nested
 * pi runs), those descendants write their own lifecycle into OUR marker
 * files — e.g. a SIGTERM'd test child writes 143 to SUMOCODE_TASK_EXIT_FILE
 * and the orchestrator falsely declares this agent dead. At install time the
 * values are captured into a module-level snapshot and deleted from the env
 * so descendants never see them.
 */
const TASK_MARKER_ENV_KEYS = [
	"SUMOCODE_TASK_RESPONSE_FILE",
	"SUMOCODE_TASK_EXIT_FILE",
	"SUMOCODE_TASK_STARTED_FILE",
	"SUMOCODE_TASK_DIAG_FILE",
	"SUMOCODE_TASK_CONTROL_DIR",
] as const;

let capturedMarkerEnv: NodeJS.ProcessEnv | undefined;

/**
 * Capture the marker-file env vars into a snapshot and scrub them from the
 * given env (typically `process.env`). Returns the snapshot.
 *
 * MERGES with any previous capture instead of replacing it. Pi recreates the
 * extension API in the SAME process for `/new`, `/resume`, and `/fork`, so a
 * second install sees an env this function already scrubbed. Replacing the
 * snapshot there would blank every marker path: response persistence would
 * stop and no replacement control watcher could be installed, silently
 * breaking steering and graceful close for the rest of the process lifetime.
 */
export function captureAndScrubTaskMarkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const snapshot: NodeJS.ProcessEnv = { ...capturedMarkerEnv };
	for (const key of TASK_MARKER_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) {
			snapshot[key] = value;
			delete env[key];
		}
	}
	capturedMarkerEnv = snapshot;
	return snapshot;
}

/** Test seam: forget the captured marker snapshot. */
export function resetTaskMarkerEnvForTests(): void {
	capturedMarkerEnv = undefined;
}

const artifactFs: PrivateArtifactFs = nodeArtifactFs;

/**
 * The task directory that owns the given marker env snapshot, when known.
 * Confinement is only checkable against it.
 */
const taskDirFromMarkers = (markers: NodeJS.ProcessEnv | undefined): string | undefined => {
	const controlDir = markers?.SUMOCODE_TASK_CONTROL_DIR;
	return controlDir ? dirname(resolve(controlDir)) : undefined;
};

/**
 * Marker paths are a private contract between the orchestrating parent and
 * THIS process, delivered through the trusted launch env. Capture time
 * confines every marker to the task directory that owns the control dir and
 * normalizes it to that resolved spelling, so relative or `..`-decorated
 * marker values cannot diverge between validation and the writers. Markers
 * outside the task dir are dropped (fail closed) with a diagnostic.
 */
function sanitizeTaskMarkers(markers: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const taskDir = taskDirFromMarkers(markers);
	if (!taskDir) {
		const refused = TASK_MARKER_ENV_KEYS.filter((key) => markers[key] !== undefined && key !== "SUMOCODE_TASK_CONTROL_DIR");
		// Two-phase: quarantine EVERY refused marker (including the diag sink)
		// before logging any of them, so no refusal is ever appended through an
		// unvalidated diagnostic path.
		const refusedMarkers = refused.map((key) => ({ key, file: markers[key] }));
		for (const { key } of refusedMarkers) delete markers[key];
		for (const { key, file } of refusedMarkers) {
			diagLog("marker_refused", { file, message: `${key} set without SUMOCODE_TASK_CONTROL_DIR` });
		}
		return markers;
	}
	// DIAG and CONTROL first: diagLog consumes the snapshot being mutated, so
	// the diag path must already be validated before refusals are logged for
	// the remaining markers.
	const orderedKeys = [
		"SUMOCODE_TASK_CONTROL_DIR",
		"SUMOCODE_TASK_DIAG_FILE",
		...TASK_MARKER_ENV_KEYS.filter((key) => key !== "SUMOCODE_TASK_CONTROL_DIR" && key !== "SUMOCODE_TASK_DIAG_FILE"),
	] as const;
	for (const key of orderedKeys) {
		const value = markers[key];
		if (value === undefined) continue;
		if (key === "SUMOCODE_TASK_CONTROL_DIR") {
			// The anchor itself: confinement is relative to its own parent dir.
			markers[key] = resolve(value);
			continue;
		}
		try {
			assertArtifactInsideDir(resolve(value), taskDir, key);
			markers[key] = resolve(value);
		} catch (error) {
			// Quarantine the refused marker BEFORE logging: when the refused key is
			// the diag sink itself, the refusal must not be appended through the
			// very path that just failed validation.
			delete markers[key];
			diagLog("marker_refused", { file: value, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return markers;
}

/**
 * Validate-then-write a task artifact the child itself owns. A valid existing
 * entry is overwritten in place (response.md is rewritten every turn); an
 * absent entry is created with an exclusive, no-follow create. Anything else
 * — including a dangling symlink planted at the artifact path — throws, and
 * the caller's catch records a truthful diagnostic instead of writing through
 * the replaced path. When the owning task dir is known, the entry is also
 * re-checked for direct-child confinement at write time.
 */
function writeOwnedTaskArtifact(file: string, contents: string, label: string, taskDir?: string): void {
	const parentDir = taskDir ?? dirname(file);
	const existing = validatedArtifactStat(artifactFs, file, parentDir, label);
	if (existing === undefined) {
		writeFileSync(file, contents, { mode: PRIVATE_FILE_MODE, flag: "wx" });
		return;
	}
	// ponytail: overwrite window between validate and write is not closeable
	// portably (O_NOFOLLOW is POSIX-only and untyped here); closing it needs an
	// openat seam, which waits for an upstream need. Exploiting the window
	// already requires owner access to the 0700 task dir.
	writeFileSync(file, contents, { mode: PRIVATE_FILE_MODE });
}

interface DiagDetail {
	readonly reason?: string;
	readonly file?: string;
	readonly bytes?: number;
	readonly message?: string;
	readonly taskMode?: string;
	readonly keepOpen?: string;
	readonly graceMs?: number;
	readonly source?: string;
	readonly pending?: boolean;
	readonly code?: number;
	readonly remaining?: number;
}

/**
 * Env-gated diagnostic logging. The spawn pipeline points
 * `SUMOCODE_TASK_DIAG_FILE` at `diag.jsonl` inside the private task dir; the
 * capture-time sanitizer confines it there (and drops it otherwise), since the
 * trail names task artifact paths. No-op when the env var is unset.
 */
function diagLog(event: string, detail?: DiagDetail): void {
	// The sanitized capture is the only marker source — same as persistResponse.
	const file = capturedMarkerEnv?.SUMOCODE_TASK_DIAG_FILE;
	if (!file) return;
	try {
		// The sink goes through the same boundary as every other artifact: an
		// absent entry is created exclusively (no-follow), an existing entry must
		// still be a private regular file, and anything tampered drops the line.
		// Confinement was capture-checked; per-append this is identity re-check.
		const stat = validatedArtifactStat(artifactFs, file, dirname(file), "task diag artifact");
		if (stat === undefined) {
			writeFileSync(file, "", { mode: PRIVATE_FILE_MODE, flag: "wx" });
		}
		appendFileSync(
			file,
			`${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...(detail ?? undefined) })}\n`,
			{ mode: PRIVATE_FILE_MODE },
		);
	} catch {
		// diagnostics must never crash the extension — a refused sink drops the line
	}
}

/**
 * Pull the final assistant text out of an agent_end message bundle.
 *
 * Pi's agent_end fires with `event.messages` for the just-completed turn.
 * The terminal assistant message holds the response we want to harvest;
 * earlier assistant messages are intermediate tool-calling turns.
 * Content is a block array (text blocks, tool_use blocks, etc.) — we
 * concatenate all text blocks of the last assistant message.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- predicate over an untyped Pi block field; the typeof check is the sanctioned parse.
function isText(value: unknown): value is string {
	return typeof value === "string";
}

export function extractFinalAssistantText(messages: unknown[]): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		// SAFETY: agent_end messages are untrusted Pi payloads; each entry is
		// narrowed by the role/content guards below.
		const msg = messages[i] as { role?: unknown; content?: unknown } | null;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts: string[] = [];
		// SAFETY: msg.content was checked to be an array above; each block is
		// narrowed by the type/text guards below.
		for (const block of msg.content as Array<{ type?: unknown; text?: unknown }>) {
			if (block && block.type === "text" && isText(block.text)) {
				parts.push(block.text);
			}
		}
		if (parts.length > 0) return parts.join("\n").trim();
	}
	return "";
}

/**
 * Persist the agent's final response so the orchestrating session can read it.
 *
 * Writes to `$SUMOCODE_TASK_RESPONSE_FILE`, which the visible-subagent
 * backend reads after the child process settles. Updated on every agent_end
 * so a multi-turn pane always exposes its latest assistant response.
 */
function persistResponse(messages: unknown[]): void {
	// The sanitized capture is the only marker source: a raw process.env probe
	// here would bypass capture-time confinement.
	const file = capturedMarkerEnv?.SUMOCODE_TASK_RESPONSE_FILE;
	if (!file) {
		diagLog("response_skipped", { reason: "no_env" });
		return;
	}
	const text = extractFinalAssistantText(messages);
	if (!text) {
		diagLog("response_skipped", { reason: "no_text" });
		return;
	}
	try {
		writeOwnedTaskArtifact(file, `${text}\n`, "task response artifact", taskDirFromMarkers(capturedMarkerEnv));
		diagLog("response_written", { file, bytes: text.length });
	} catch (error) {
		diagLog("response_write_failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export function writeTaskExitMarker(code: number, env: NodeJS.ProcessEnv = process.env): void {
	const file = env.SUMOCODE_TASK_EXIT_FILE;
	if (!file) return;
	try {
		writeOwnedTaskArtifact(file, `${code}\n`, "task exit marker", taskDirFromMarkers(env));
		diagLog("exit_marker_written", { file, code });
	} catch (error) {
		diagLog("exit_marker_write_failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export function writeTaskStartedMarker(env: NodeJS.ProcessEnv = process.env): void {
	const file = env.SUMOCODE_TASK_STARTED_FILE;
	if (!file) return;
	try {
		writeOwnedTaskArtifact(file, `${process.pid}\n`, "task started marker", taskDirFromMarkers(env));
		diagLog("started_marker_written", { file });
	} catch (error) {
		diagLog("started_marker_write_failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function isNumber(value: number | undefined): value is number {
	return typeof value === "number";
}

function errorMessage<T>(error: T): string {
	return error instanceof Error ? error.message : String(error);
}

/** True when a failed unlink reports the control file is already absent. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary predicate: fs rejections arrive as `unknown` from catch clauses; isErrnoCode is the sanctioned parse before the errno check.
function isEnoent(error: unknown): boolean {
	return isErrnoCode(error, "ENOENT");
}

function installTaskExitMarker(env: NodeJS.ProcessEnv = process.env): void {
	if (!env.SUMOCODE_TASK_EXIT_FILE) return;
	process.once("exit", (code) => writeTaskExitMarker(isNumber(code) ? code : 0, env));
}

const STATUS_KEY = "sumocode-task-auto-exit";
const DEFAULT_GRACE_MS = 30_000;
const TICK_MS = 1_000;
const CONTROL_POLL_MS = 500;
const CLOSE_REQUEST_FILE = "close.request";
const STEER_FILE_PATTERN = /^steer-(\d+)\.txt$/;

export interface TaskModeAutoExitOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly graceMs?: number;
	/**
	 * Ack-unlink seam (dependency injection for tests): defaults to the real
	 * unlinkSync. The watcher only ever unlinks control files with it.
	 */
	readonly unlink?: (path: string) => void;
}

/** True when task mode is active. Mirrors `isTaskMode` in extension.ts. */
function isActive(env: NodeJS.ProcessEnv): boolean {
	return env.SUMOCODE_TASK_MODE === "1";
}

/** True when the user has explicitly disabled auto-exit. */
function isKeepOpen(env: NodeJS.ProcessEnv): boolean {
	return env.SUMOCODE_TASK_KEEP_OPEN === "1";
}

export function shouldInstallTaskModeAutoExit(options: TaskModeAutoExitOptions = {}): boolean {
	const env = options.env ?? process.env;
	return isActive(env) && !isKeepOpen(env);
}

interface TaskModeControlHooks {
	getLatestCtx(): ExtensionContext | undefined;
	cancelCountdown(): void;
	/** Shut down now, or defer until the active turn reaches `agent_end`. */
	requestShutdown(ctx: ExtensionContext): void;
}

const SUBMITTED_CONTROLS_REGISTRY = Symbol.for("sumocode.task-mode.submittedControls");

type SubmittedControlsScope = { [SUBMITTED_CONTROLS_REGISTRY]?: Map<string, Set<string>> };

function globalSubmittedControlsScope(): SubmittedControlsScope {
	// SAFETY: SubmittedControlsScope only adds an optional module-private symbol
	// key to globalThis, which no other module reads or writes under that symbol.
	return globalThis as SubmittedControlsScope;
}

/**
 * Process-wide registry of controls whose synchronous Pi submission already
 * succeeded, keyed by canonical control directory. It lives on globalThis
 * behind a `Symbol.for` key — the same pattern as the process-install latch in
 * `extension.ts` — because ONE process can hold distinct SumoCode module
 * instances at once (source checkout plus committed bundle, or several entry
 * paths). A per-module-instance Map would let a second instance's watcher
 * resubmit a control the first instance's watcher already handed to Pi.
 * Lifetime is exactly the process: Pi recreates the extension API in the SAME
 * process for `/new`, `/resume`, and `/fork`, and this registry spans all of
 * those, but a child process restart loses it — resubmission after a restart
 * remains an upstream/durable-protocol ambiguity this in-process registry does
 * not solve. Entries are removed when the ack unlink finally succeeds (or the
 * control is already absent), and empty directory buckets are deleted, so
 * ordinary watcher stops neither clear nor leak pending ownership.
 */
function submittedControlsRegistry(): Map<string, Set<string>> {
	const scope = globalSubmittedControlsScope();
	return scope[SUBMITTED_CONTROLS_REGISTRY] ??= new Map<string, Set<string>>();
}

const submittedControlsFor = (canonicalControlDir: string): Set<string> => {
	const registry = submittedControlsRegistry();
	let bucket = registry.get(canonicalControlDir);
	if (!bucket) {
		bucket = new Set();
		registry.set(canonicalControlDir, bucket);
	}
	return bucket;
};

/** Drop a submitted entry after its consumption acknowledgement is complete. */
const clearSubmittedControl = (canonicalControlDir: string, file: string): void => {
	const registry = submittedControlsRegistry();
	const bucket = registry.get(canonicalControlDir);
	if (!bucket?.delete(file)) return;
	if (bucket.size === 0) registry.delete(canonicalControlDir);
};

const isControlSubmitted = (canonicalControlDir: string, file: string): boolean =>
	submittedControlsRegistry().get(canonicalControlDir)?.has(file) ?? false;

/**
 * Test seam: a cloned read-only snapshot of the process-wide submitted-control
 * registry. Cloning keeps the live Map/Sets private — mutating the snapshot
 * can never touch (or leak) real ownership state.
 */
export function submittedControlsForTests(): ReadonlyMap<string, ReadonlySet<string>> {
	return new Map([...submittedControlsRegistry()].map(([dir, files]) => [dir, new Set(files)]));
}

/** Test-only: clear the process-wide submitted-control registry (same pattern as `resetSumocodeProcessInstallLatchForTests` in `extension.ts`) so it cannot leak across tests or files. */
export function resetSubmittedControlsForTests(): void {
	delete globalSubmittedControlsScope()[SUBMITTED_CONTROLS_REGISTRY];
}

/**
 * Poll `<controlDir>` for orchestrator control files (the parent-side writer
 * lives in `src/subagents/backend-pane.ts`). Steer files are consumed and
 * synchronously submitted to Pi; `close.request` shuts the child down. The
 * watcher is independent of the auto-exit countdown: it also runs for
 * keep-open sessions, because close is explicit while auto-exit is silence.
 */
function installControlWatcher(
	pi: ExtensionAPI,
	controlDir: string | undefined,
	hooks: TaskModeControlHooks,
	unlinkControl: (path: string) => void,
): () => void {
	if (!controlDir) return () => undefined;
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	// Canonicalize exactly once: the registry key, readdir, and every
	// close/steer member path share this one spelling, so an equivalent
	// relative/trailing-separator control-dir spelling cannot merge a bucket key
	// while diverging member paths.
	const canonicalControlDir = resolve(controlDir);
	// The control channel is a private parent-child contract. A tampered
	// directory (replaced by a symlink, group/other-readable, or owned by
	// someone else) fails closed permanently; a not-yet-created one is the
	// documented boot ordering and is retried on later ticks.
	// No successful-validation cache: the directory is re-validated on every
	// tick so a symlink or widened mode swapped in after the first validation is
	// never traversed. ENOENT (not yet created) is retried; any other refusal is
	// logged once and fails closed.
	let controlDirRefusalLogged = false;
	const ensureControlDirValidated = (): boolean => {
		try {
			assertPrivateDir(artifactFs, canonicalControlDir, "task control directory");
			return true;
		} catch (error) {
			if (!isErrnoCode(error, "ENOENT") && !controlDirRefusalLogged) {
				controlDirRefusalLogged = true;
				diagLog("control_dir_refused", {
					file: canonicalControlDir,
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return false;
		}
	};
	// The watcher always installs: the per-tick gate re-validates the directory
	// before consuming anything, so a tampered dir fails closed without a
	// disable race, an absent dir is the documented boot ordering, and a dir
	// fixed (or created) later starts being consumed on the next poll.
	// Submission ownership lives in the process-wide submitted-controls registry,
	// so watcher recreation and sibling module instances keep it. Ordinary stops
	// deliberately clear nothing here: clearing would let a recreated watcher
	// resubmit a control Pi already owns when only the ack unlink was still
	// failing.

	const stop = (): void => {
		stopped = true;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	/** Acknowledgement cleanup: unlink the consumed control, never resubmit. */
	const discardSubmittedControl = (file: string): void => {
		try {
			// The entry must still be our private artifact before removal; a
			// replaced path stays on disk (the parent's send then stays ambiguous
			// and recoverable) and ownership is retained so it is never resubmitted.
			assertPrivateArtifact(artifactFs, file, canonicalControlDir, "steer control");
			unlinkControl(file);
			clearSubmittedControl(canonicalControlDir, file);
			diagLog("steer_ack_unlinked", { file });
		} catch (error) {
			if (isEnoent(error)) {
				// The control is already absent: the consumption acknowledgement is
				// complete. Ownership clears and nothing is retained or retried.
				clearSubmittedControl(canonicalControlDir, file);
				diagLog("steer_ack_already_unlinked", { file });
				return;
			}
			// Truthful ack-cleanup diagnostic — the submission itself succeeded and
			// must not be retried; only the unlink is pending.
			diagLog("steer_ack_unlink_failed", { file, message: errorMessage(error) });
		}
	};

	const submitSteer = (file: string): void => {
		if (isControlSubmitted(canonicalControlDir, file)) {
			// Submission already handed this control to Pi. Retry the unlink only.
			discardSubmittedControl(file);
			return;
		}
		let text: string;
		try {
			// Only consume controls that are still private regular artifacts of this
			// control dir. A replaced or redirected path fails closed: the file
			// remains so the parent's send budget resolves as an ambiguous timeout,
			// which the existing protocol treats as recoverable.
			assertPrivateArtifact(artifactFs, file, canonicalControlDir, "steer control");
			text = readFileSync(file, "utf8");
		} catch (error) {
			diagLog("steer_read_failed", { file, message: errorMessage(error) });
			return;
		}
		if (!text.trim()) {
			// Legacy blank control: nothing to submit, so no Pi call and no
			// submission diagnostic. Deletion still records consumption so the
			// orchestrator does not wait out its full budget.
			try {
				unlinkControl(file);
				diagLog("steer_blank_consumed", { file });
			} catch {
				// nothing to salvage from an unreadable empty file
			}
			return;
		}
		hooks.cancelCountdown();
		try {
			// ExtensionAPI.sendUserMessage returns void (unlike the internal
			// ReplacedSessionContext method). A true acceptance ACK requires an
			// upstream awaitable result or callback; this call can observe only a
			// synchronous throw. Do not add a cosmetic await here.
			pi.sendUserMessage(text, { deliverAs: "steer" });
		} catch (error) {
			// A synchronous throw means Pi does not own the request: preserve the
			// file so a later poll can retry the submission.
			diagLog("steer_submit_failed", { file, message: errorMessage(error) });
			return;
		}
		// Submission succeeded — record ownership process-wide so no watcher in
		// any module instance ever resubmits it, even across session recreation
		// while the ack unlink keeps failing.
		submittedControlsFor(canonicalControlDir).add(file);
		try {
			// Unlink tells the parent that the watcher consumed the control and the
			// synchronous submission did not throw. It is not model-turn delivery.
			unlinkControl(file);
			clearSubmittedControl(canonicalControlDir, file);
			diagLog("steer_submitted", { file, bytes: text.length });
		} catch (error) {
			if (isEnoent(error)) {
				// Removed between the read and this unlink: the consumption
				// acknowledgement is already complete; ownership clears, nothing retries.
				clearSubmittedControl(canonicalControlDir, file);
				diagLog("steer_ack_already_unlinked", { file, bytes: text.length });
				return;
			}
			diagLog("steer_ack_unlink_failed", { file, message: errorMessage(error) });
		}
	};

	const tick = (): void => {
		try {
			const ctx = hooks.getLatestCtx();
			if (!ensureControlDirValidated()) return;
			// Gate EVERY control action on a captured context. Its absence means
			// session_start has not fired, i.e. the extension runtime is still
			// loading — and both `sendUserMessage` and `shutdown` throw during
			// loading ("Extension runtime not initialized"). Ticking anyway burns
			// the first submission attempt and can push control consumption past the
			// parent's acknowledgement budget. Retry next tick instead.
			if (!ctx) return;
			const closePath = join(canonicalControlDir, CLOSE_REQUEST_FILE);
			if (existsSync(closePath)) {
				try {
					// A replaced or symlinked close control is not ours: refuse it and
					// keep polling (steering stays live) rather than shutting down
					// through an untrusted path.
					assertPrivateArtifact(artifactFs, closePath, canonicalControlDir, "close control");
					diagLog("close_requested");
					hooks.cancelCountdown();
					stop();
					hooks.requestShutdown(ctx);
					return;
				} catch (error) {
					diagLog("close_refused", { file: closePath, message: errorMessage(error) });
				}
			}
			let entries: string[];
			try {
				entries = readdirSync(canonicalControlDir);
			} catch {
				// The parent creates the dir at spawn, but the child can boot
				// first — tolerate a missing dir until it appears.
				return;
			}
			const seqOf = (name: string): number => Number(name.match(STEER_FILE_PATTERN)?.[1] ?? Number.MAX_SAFE_INTEGER);
			const steerFiles = entries.filter((entry) => STEER_FILE_PATTERN.test(entry)).sort((a, b) => seqOf(a) - seqOf(b));
			for (const name of steerFiles) submitSteer(join(canonicalControlDir, name));
		} catch (error) {
			diagLog("control_poll_failed", { message: errorMessage(error) });
		}
	};

	timer = setInterval(() => {
		if (!stopped) tick();
	}, CONTROL_POLL_MS);
	timer.unref?.();
	return stop;
}

/**
 * Install the task-mode lifecycle. Idempotent within a session — the
 * extension calls this once during install.
 *
 * Marker capture and the control-file watcher run for EVERY task-mode
 * session (steer/close are orchestrator channels, independent of silence);
 * only the auto-exit countdown wiring is skipped by keep-open.
 */
export function installTaskModeAutoExit(pi: ExtensionAPI, options: TaskModeAutoExitOptions = {}): void {
	const env = options.env ?? process.env;
	if (!isActive(env)) {
		diagLog("install_skipped", {
			taskMode: env.SUMOCODE_TASK_MODE,
			keepOpen: env.SUMOCODE_TASK_KEEP_OPEN,
		});
		return;
	}

	// Capture marker paths, then scrub them from the env so subprocesses
	// spawned by this agent cannot clobber the orchestrator's marker files.
	// Sanitization confines every marker to the task directory that owns the
	// control dir; refused markers are dropped before any downstream writer or
	// the control watcher can touch them.
	const markers = sanitizeTaskMarkers(captureAndScrubTaskMarkerEnv(env));
	writeTaskStartedMarker(markers);
	installTaskExitMarker(markers);

	const countdownEnabled = shouldInstallTaskModeAutoExit(options);
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	let latestCtx: ExtensionContext | undefined;
	let pending: { tick: ReturnType<typeof setInterval>; shutdown: ReturnType<typeof setTimeout> } | undefined;
	let everArmed = false;
	// A turn is active between agent_start and agent_end. Close requests that
	// arrive inside that window must wait for it: agent_end is the ONLY place
	// response.md is written.
	let turnActive = false;
	let closeRequested = false;

	const cancelPending = (ctx: ExtensionContext): void => {
		if (!pending) return;
		clearInterval(pending.tick);
		clearTimeout(pending.shutdown);
		pending = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	/** Arm a fresh silence countdown, replacing any live one. */
	const armCountdown = (ctx: ExtensionContext): void => {
		cancelPending(ctx);
		let remaining = Math.ceil(graceMs / 1000);
		diagLog(everArmed ? "timer_rearmed" : "timer_armed", { graceMs, remaining });
		everArmed = true;
		ctx.ui.setStatus(STATUS_KEY, `task done · exiting in ${remaining}s · type or steer to extend`);

		const tick = setInterval(() => {
			remaining -= 1;
			if (remaining > 0) {
				ctx.ui.setStatus(STATUS_KEY, `task done · exiting in ${remaining}s · type or steer to extend`);
			}
		}, TICK_MS);

		const shutdown = setTimeout(() => {
			diagLog("timer_fired");
			cancelPending(ctx);
			ctx.shutdown();
		}, graceMs);

		pending = { tick, shutdown };
	};

	const shutdownNow = (ctx: ExtensionContext): void => {
		cancelPending(ctx);
		ctx.shutdown();
	};

	const stopWatcher = installControlWatcher(pi, markers.SUMOCODE_TASK_CONTROL_DIR, {
		getLatestCtx: () => latestCtx,
		cancelCountdown: () => {
			if (latestCtx) cancelPending(latestCtx);
		},
		requestShutdown: (ctx) => {
			if (turnActive) {
				// Exiting mid-turn would settle the parent on a stale or empty
				// response.md while reporting a normal completion — silently losing
				// the work the child is producing right now. agent_end persists the
				// turn and then honors this request.
				closeRequested = true;
				diagLog("close_deferred_active_turn");
				return;
			}
			shutdownNow(ctx);
		},
	}, options.unlink ?? unlinkSync);

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});

	// Turn tracking, response persistence, and deferred close are registered for
	// EVERY task-mode session. They are orchestrator-facing guarantees, not
	// countdown behavior, so keep-open sessions need them too.
	pi.on("agent_start", (_event, ctx) => {
		latestCtx = ctx;
		turnActive = true;
		// A turn is running — never exit mid-turn. agent_end re-arms afterwards.
		if (pending) {
			cancelPending(ctx);
			diagLog("timer_cancelled_agent_start");
		}
	});

	pi.on("agent_end", (event, ctx) => {
		latestCtx = ctx;
		turnActive = false;
		diagLog("agent_end", { pending: pending !== undefined });
		// Always persist the latest completed turn. Completion is keyed off the
		// real process-exit marker, so response.md can be overwritten safely if a
		// human takes over and sends follow-up turns before shutdown.
		persistResponse(
			// SAFETY: agent_end carries the completed turn's messages; non-array
			// payloads fall back to an empty list below.
			(event as { messages?: unknown[] }).messages ?? [],
		);
		if (closeRequested) {
			// The deferred close from mid-turn: the finished turn is now on disk.
			diagLog("close_completed_after_turn");
			shutdownNow(ctx);
			return;
		}
		if (countdownEnabled) armCountdown(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		diagLog("session_shutdown");
		stopWatcher();
		// Defensive cleanup if shutdown is triggered by a different path
		// (e.g. user hits Ctrl+D while our timer is running).
		cancelPending(ctx);
	});

	if (!countdownEnabled) {
		// Keep-open opts out of the silence countdown only; the watcher, turn
		// tracking, and response persistence above stay live.
		diagLog("install_skipped", {
			taskMode: env.SUMOCODE_TASK_MODE,
			keepOpen: env.SUMOCODE_TASK_KEEP_OPEN,
		});
		return;
	}

	diagLog("install", { graceMs });

	pi.on("input", (event, ctx) => {
		latestCtx = ctx;
		diagLog("input", { source: event.source, pending: pending !== undefined });
		if (event.source !== "interactive") return;
		if (pending) {
			// A human is driving the pane. Drop this countdown; the next
			// agent_end re-arms, so the pane only exits after a further full
			// silence window. Before the first agent_end there is no countdown,
			// so the CLI kickoff prompt is naturally a no-op here.
			cancelPending(ctx);
			diagLog("timer_cancelled_input");
			ctx.ui.notify("task auto-exit deferred — the countdown re-arms after this turn", "info");
		}
	});

}
