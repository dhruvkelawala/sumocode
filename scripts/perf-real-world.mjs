#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_MS = 50;
const TIMEOUT_MS = 60_000;
const RUNS = 3;
const REPORT_PATH = resolve(ROOT, "docs", "perf", "real-world.md");

function herdr(args) {
	return execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parseJsonOutput(output) {
	try {
		return JSON.parse(output);
	} catch {}
	for (const line of output.trim().split("\n").reverse()) {
		try {
			return JSON.parse(line);
		} catch {}
	}
	return undefined;
}

function collectPaneMatches(value, name, scratch, matches = []) {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- guard on parsed tmux pane JSON
	if (!value || typeof value !== "object") return matches;
	if (Array.isArray(value)) {
		for (const entry of value) collectPaneMatches(entry, name, scratch, matches);
		return matches;
	}
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- field check on parsed pane JSON
	if (typeof value.pane_id === "string") {
		const isMatch = value.agent === name || value.name === name || value.label === name || value.cwd === scratch;
		if (isMatch) matches.push(value.pane_id);
	}
	for (const child of Object.values(value)) collectPaneMatches(child, name, scratch, matches);
	return matches;
}

function paneFromOutput(output, name, scratch) {
	return collectPaneMatches(parseJsonOutput(output), name, scratch)[0];
}

function listPane(name, scratch) {
	try {
		return paneFromOutput(herdr(["agent", "list"]), name, scratch)
			?? paneFromOutput(herdr(["pane", "list"]), name, scratch);
	} catch {
		return undefined;
	}
}

function startProbe(name, scratch, diag) {
	const output = herdr([
		"agent",
		"start",
		name,
		"--cwd",
		scratch,
		"--no-focus",
		"--env",
		`PATH=${process.env.PATH}`,
		"--env",
		`SUMO_TUI_DIAG_FILE=${diag}`,
		"--env",
		"SUMO_TUI_DEBUG=1",
		"--",
		resolve(ROOT, "bin", "sumocode.sh"),
		"--no-session",
	]);
	return paneFromOutput(output, name, scratch) ?? listPane(name, scratch);
}

async function readEvents(diag) {
	try {
		const raw = await readFile(diag, "utf8");
		return raw.split("\n").filter(Boolean).flatMap((line) => {
			try {
				const event = JSON.parse(line);
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- guard on parsed diagnostics JSONL event
				return event && typeof event === "object" ? [event] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

async function waitForEvent(diag, eventName, occurrence) {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		const events = await readEvents(diag);
		const matching = events.filter((event) => event.event === eventName);
		if (matching.length >= occurrence) return { events, event: matching[occurrence - 1] };
		await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
	}
	const events = await readEvents(diag);
	const error = new Error(`timed out waiting for ${eventName} occurrence ${occurrence}`);
	error.code = "diag-timeout";
	error.events = events;
	throw error;
}

async function waitForInputReady(diag, occurrence) {
	return waitForEvent(diag, "input_ready", occurrence);
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return undefined;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatMetric(value) {
	return value === undefined ? "failed" : `${value}ms`;
}

export function publicProbeError(error) {
	return error?.code === "diag-timeout" ? "diagnostic event timeout" : "probe command failed";
}

function markdown(report) {
	const rows = report.runs.map((run) => `| ${run.run} | ${formatMetric(run.startup_ms)} | ${formatMetric(run.first_frame_ms)} | ${formatMetric(run.app_ready_ms)} | ${formatMetric(run.reload_ms)} | ${formatMetric(run.reload_app_ready_ms)} | ${run.error ?? ""} |`);
	return `# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: \`${report.commit}\`
- generated: ${report.generatedAt}
- scratch project: \`${report.scratchProject}\`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows.join("\n")}

| Metric | Median |
| --- | ---: |
| startup_ms | ${formatMetric(report.medians.startup_ms)} |
| first_frame_ms | ${formatMetric(report.medians.first_frame_ms)} |
| app_ready_ms | ${formatMetric(report.medians.app_ready_ms)} |
| reload_ms | ${formatMetric(report.medians.reload_ms)} |
| reload_app_ready_ms | ${formatMetric(report.medians.reload_app_ready_ms)} |
`;
}

function gitCommit() {
	return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function closePane(pane) {
	if (!pane) return;
	try {
		herdr(["pane", "close", pane]);
	} catch {}
}

async function run() {
	try {
		herdr(["status"]);
	} catch {
		console.log("real-world lane skipped: herdr not running");
		return;
	}

	const scratch = `/tmp/sumocode-perf-rw-${process.pid}`;
	const startedPanes = new Set();
	const results = [];
	let consecutiveReloadFailures = 0;
	await mkdir(scratch);
	try {
		execFileSync("git", ["init", "-q"], { cwd: scratch, stdio: "ignore" });
		await writeFile(resolve(scratch, "README.md"), "# SumoCode perf probe\n");
		execFileSync("git", ["add", "README.md"], { cwd: scratch, stdio: "ignore" });
		execFileSync("git", ["-c", "user.name=SumoCode perf", "-c", "user.email=perf@sumocode.invalid", "commit", "-qm", "baseline"], { cwd: scratch, stdio: "ignore" });

		for (let index = 1; index <= RUNS; index += 1) {
			const name = `perf-probe-${index}`;
			const diag = resolve(scratch, `diag-${index}.jsonl`);
			let pane;
			let startupMs;
			let firstFrameMs;
			let appReadyMs;
			let reloadMs;
			let reloadAppReadyMs;
			let errorMessage;
			try {
				const t0 = Date.now();
				pane = startProbe(name, scratch, diag);
				if (!pane) throw new Error(`could not resolve pane for ${name}`);
				startedPanes.add(pane);
				const startup = await waitForInputReady(diag, 1);
				const bootFrame = startup.events.find((event) => event.event === "boot_screen_frame");
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- timestamp check on parsed diagnostics event
				if (typeof bootFrame?.ts !== "number") throw new Error("startup diagnostics did not include boot_screen_frame");
				firstFrameMs = bootFrame.ts - t0;
				const startupAppReady = await waitForEvent(diag, "app_ready", 1);
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- timestamp check on parsed diagnostics event
				if (typeof startupAppReady.event.ts !== "number") throw new Error("startup diagnostics did not include app_ready");
				startupMs = startup.event.ts - t0;
				appReadyMs = startupAppReady.event.ts - t0;

				herdr(["pane", "send-text", pane, "/reload"]);
				await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
				// A line-start slash completion auto-submits when Enter accepts it.
				// Start timing before that Enter so reload_ms includes the command
				// dispatch instead of omitting the first POLL_MS of real work.
				const t1 = Date.now();
				herdr(["pane", "send-keys", pane, "Enter"]);
				const reload = await waitForInputReady(diag, 2);
				const reloadAppReady = await waitForEvent(diag, "app_ready", 2);
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- timestamp check on parsed diagnostics event
				if (typeof reloadAppReady.event.ts !== "number") throw new Error("reload diagnostics did not include app_ready");
				reloadMs = reload.event.ts - t1;
				reloadAppReadyMs = reloadAppReady.event.ts - t1;
				herdr(["pane", "read", pane, "--lines", "5"]);
				consecutiveReloadFailures = 0;
			} catch (error) {
				// execFileSync error messages may embed Herdr stderr. Keep the raw
				// diagnostic local and serialize only a fixed public-safe category.
				console.error(`[perf-real-world] ${name}: ${error instanceof Error ? error.message : String(error)}`);
				errorMessage = publicProbeError(error);
				if (pane) {
					try {
						const lines = error?.code === "diag-timeout" ? "30" : "5";
						const paneRead = herdr(["pane", "read", pane, "--lines", lines]);
						// Pane output can contain operator-specific provider/auth or extension
						// diagnostics. Keep it local to the console; never persist it in the
						// committed public performance report.
						console.error(`[perf-real-world] ${name} pane tail:\n${paneRead.trim()}`);
					} catch {
						console.error(`[perf-real-world] ${name} pane read failed`);
					}
				}
				if (startupMs === undefined) throw error;
				consecutiveReloadFailures += 1;
				if (consecutiveReloadFailures >= RUNS) throw new Error(`reload failed on ${consecutiveReloadFailures} consecutive attempts: ${errorMessage}`);
			} finally {
				if (!pane) pane = listPane(name, scratch);
				if (pane) {
					startedPanes.add(pane);
					closePane(pane);
				}
			}
			results.push({ run: index, startup_ms: startupMs, first_frame_ms: firstFrameMs, app_ready_ms: appReadyMs, reload_ms: reloadMs, reload_app_ready_ms: reloadAppReadyMs, error: errorMessage });
		}

		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- numeric-filter over collected run timings
		const successful = (key) => results.map((runResult) => runResult[key]).filter((value) => typeof value === "number");
		const report = {
			commit: gitCommit(),
			generatedAt: new Date().toISOString(),
			scratchProject: scratch,
			runs: results,
			medians: {
				startup_ms: median(successful("startup_ms")),
				first_frame_ms: median(successful("first_frame_ms")),
				app_ready_ms: median(successful("app_ready_ms")),
				reload_ms: median(successful("reload_ms")),
				reload_app_ready_ms: median(successful("reload_app_ready_ms")),
			},
		};
		const output = markdown(report);
		await writeFile(REPORT_PATH, output);
		console.log(output);
	} finally {
		for (const pane of startedPanes) closePane(pane);
		await rm(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	run().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
