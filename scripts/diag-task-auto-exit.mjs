#!/usr/bin/env node
/**
 * Diagnose `sumocode task` auto-exit end-to-end.
 *
 * Spawns a real sumocode task pane in cmux, captures the lifecycle events
 * the auto-exit code writes to a diag file, and reports whether the pane
 * actually closes. Designed to be runnable in a tight loop so we can iterate
 * on the fix without slow manual back-and-forth.
 *
 * Usage:
 *   node scripts/diag-task-auto-exit.mjs [--grace 10000] [--keep-pane-on-fail]
 *
 * Exit code:
 *   0  pane closed within the grace + slack window
 *   1  pane did not close (auto-exit broken)
 *   2  setup error (cmux unavailable, pane never opened, etc.)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const idx = args.indexOf(name);
	if (idx === -1) return fallback;
	return args[idx + 1] ?? fallback;
};
const hasFlag = (name) => args.includes(name);

const graceMs = Number.parseInt(arg("--grace", "10000"), 10);
const slackMs = Number.parseInt(arg("--slack", "8000"), 10);
const keepPaneOnFail = hasFlag("--keep-pane-on-fail");

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const workDir = join(tmpdir(), "sumocode-task-diag", runId);
mkdirSync(workDir, { recursive: true });
const promptFile = join(workDir, "prompt.txt");
const diagFile = join(workDir, "diag.jsonl");

const PROMPT = "Reply with exactly: diag-ping";
writeFileSync(promptFile, PROMPT);
writeFileSync(diagFile, "");

/** Run cmux CLI, return { code, stdout, stderr }. */
function cmux(...cliArgs) {
	const result = spawnSync("cmux", cliArgs, { encoding: "utf8" });
	return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function cmuxJson(...cliArgs) {
	const r = cmux(...cliArgs);
	if (r.code !== 0) throw new Error(`cmux ${cliArgs.join(" ")} failed: ${r.stderr || r.stdout}`);
	return JSON.parse(r.stdout);
}

function log(stage, detail) {
	const out = { t: Date.now(), stage, ...(detail ?? {}) };
	console.log(JSON.stringify(out));
}

function readDiagEvents() {
	if (!existsSync(diagFile)) return [];
	return readFileSync(diagFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { event: "parse_error", raw: line };
			}
		});
}

function paneExists(workspaceRef, surfaceRef) {
	try {
		const data = cmuxJson("--json", "list-panes", "--workspace", workspaceRef);
		return (data.panes ?? []).some(
			(p) =>
				p.selected_surface_ref === surfaceRef ||
				(p.surface_refs ?? []).includes(surfaceRef),
		);
	} catch {
		return false;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	log("setup", { runId, workDir, promptFile, diagFile, graceMs, slackMs });

	// 1. Discover caller context (we must be running inside cmux ourselves).
	let caller;
	try {
		caller = cmuxJson("--json", "identify").caller ?? {};
	} catch (error) {
		log("error", { phase: "identify", message: String(error) });
		process.exit(2);
	}
	if (!caller.workspace_ref || !caller.surface_ref) {
		log("error", { phase: "identify", message: "diag harness must run inside cmux" });
		process.exit(2);
	}

	const workspaceRef = caller.workspace_ref;
	log("identify", { workspaceRef, callerSurface: caller.surface_ref });

	// 2. Snapshot existing panes so we can find the new one after split.
	const beforePanes = cmuxJson("--json", "list-panes", "--workspace", workspaceRef).panes ?? [];
	const beforeSurfaces = new Set(
		beforePanes.flatMap((p) => [p.selected_surface_ref, ...(p.surface_refs ?? [])]).filter(Boolean),
	);

	// 3. Build the launch command. Identical shape to bg_task's spawn.
	const launchCmd = `cd '${ROOT}' && SUMOCODE_TASK_DIAG_FILE='${diagFile}' exec sumocode task --prompt-file '${promptFile}'`;

	// 4. Open the new split.
	const splitResult = cmux(
		"new-split",
		"right",
		"--workspace",
		workspaceRef,
		"--surface",
		caller.surface_ref,
	);
	if (splitResult.code !== 0) {
		log("error", { phase: "new-split", stderr: splitResult.stderr });
		process.exit(2);
	}
	const surfaceMatch = splitResult.stdout.match(/surface:\S+/);
	let newSurface = surfaceMatch?.[0];
	if (!newSurface) {
		await sleep(500);
		const afterPanes = cmuxJson("--json", "list-panes", "--workspace", workspaceRef).panes ?? [];
		for (const pane of afterPanes) {
			const candidates = [pane.selected_surface_ref, ...(pane.surface_refs ?? [])].filter(Boolean);
			const fresh = candidates.find((s) => !beforeSurfaces.has(s));
			if (fresh) {
				newSurface = fresh;
				break;
			}
		}
	}
	if (!newSurface) {
		log("error", { phase: "new-split", message: "could not resolve new surface" });
		process.exit(2);
	}
	log("split_opened", { surface: newSurface });

	await sleep(300);

	// 5. Inject the launch command via respawn-pane.
	const respawn = cmux(
		"respawn-pane",
		"--workspace",
		workspaceRef,
		"--surface",
		newSurface,
		"--command",
		launchCmd,
	);
	if (respawn.code !== 0) {
		log("error", { phase: "respawn-pane", stderr: respawn.stderr });
		cmux("close-surface", "--surface", newSurface);
		process.exit(2);
	}
	const t0 = Date.now();
	log("respawn_invoked", { surface: newSurface });

	// 6. Poll diag file + pane existence until the pane closes OR we time out.
	const deadline = t0 + graceMs + slackMs + 30_000; // extra slop for cold boot
	let lastDiagCount = 0;
	let lastPaneState = true;
	let closeObservedAt = null;
	let close_invoked = false;
	let timer_fired = false;
	let agent_end_seen = false;

	while (Date.now() < deadline) {
		await sleep(500);

		// Tail diag events
		const events = readDiagEvents();
		for (let i = lastDiagCount; i < events.length; i += 1) {
			const ev = events[i];
			log("diag", { dt: ev.t ? ev.t - t0 : null, ...ev });
			if (ev.event === "agent_end") agent_end_seen = true;
			if (ev.event === "timer_fired") timer_fired = true;
			if (ev.event === "close_invoking" || ev.event === "close_result" || ev.event === "close_threw" || ev.event === "close_skipped") {
				close_invoked = true;
			}
		}
		lastDiagCount = events.length;

		// Check pane state
		const present = paneExists(workspaceRef, newSurface);
		if (present !== lastPaneState) {
			log("pane_state", { dt: Date.now() - t0, present });
			lastPaneState = present;
			if (!present) {
				closeObservedAt = Date.now();
				break;
			}
		}
	}

	const dtClose = closeObservedAt ? closeObservedAt - t0 : null;
	const result = {
		closed: closeObservedAt !== null,
		dt_close_ms: dtClose,
		agent_end_seen,
		timer_fired,
		close_invoked,
	};
	log("result", result);

	// Cleanup
	if (!result.closed && !keepPaneOnFail) {
		cmux("close-surface", "--surface", newSurface);
		log("cleanup", { closedManually: true });
	}

	process.exit(result.closed ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
