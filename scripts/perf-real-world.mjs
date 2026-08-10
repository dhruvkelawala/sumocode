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
	if (!value || typeof value !== "object") return matches;
	if (Array.isArray(value)) {
		for (const entry of value) collectPaneMatches(entry, name, scratch, matches);
		return matches;
	}
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
				return event && typeof event === "object" ? [event] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

async function waitForInputReady(diag, occurrence) {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		const events = await readEvents(diag);
		const inputReady = events.filter((event) => event.event === "input_ready");
		if (inputReady.length >= occurrence) return { events, event: inputReady[occurrence - 1] };
		await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
	}
	const events = await readEvents(diag);
	const error = new Error(`timed out waiting for input_ready occurrence ${occurrence}`);
	error.code = "diag-timeout";
	error.events = events;
	throw error;
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

function markdown(report) {
	const rows = report.runs.map((run) => `| ${run.run} | ${formatMetric(run.startup_ms)} | ${formatMetric(run.first_frame_ms)} | ${formatMetric(run.reload_ms)} | ${run.error ?? ""} |`);
	return `# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: \`${report.commit}\`
- generated: ${report.generatedAt}
- scratch project: \`${report.scratchProject}\`

| Run | Startup | First frame | Reload | Notes |
| ---: | ---: | ---: | ---: | --- |
${rows.join("\n")}

| Metric | Median |
| --- | ---: |
| startup_ms | ${formatMetric(report.medians.startup_ms)} |
| first_frame_ms | ${formatMetric(report.medians.first_frame_ms)} |
| reload_ms | ${formatMetric(report.medians.reload_ms)} |
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
			let reloadMs;
			let errorMessage;
			try {
				const t0 = Date.now();
				pane = startProbe(name, scratch, diag);
				if (!pane) throw new Error(`could not resolve pane for ${name}`);
				startedPanes.add(pane);
				const startup = await waitForInputReady(diag, 1);
				const bootFrame = startup.events.find((event) => event.event === "boot_screen_frame");
				if (typeof bootFrame?.ts !== "number") throw new Error("startup diagnostics did not include boot_screen_frame");
				startupMs = startup.event.ts - t0;
				firstFrameMs = bootFrame.ts - t0;

				herdr(["pane", "send-text", pane, "/sumo:reload"]);
				// The retained editor first uses Enter to accept the async slash-command
				// completion, then the next Enter submits the command.
				await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
				herdr(["pane", "send-keys", pane, "Enter"]);
				await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
				const t1 = Date.now();
				herdr(["pane", "send-keys", pane, "Enter"]);
				const reload = await waitForInputReady(diag, 2);
				reloadMs = reload.event.ts - t1;
				herdr(["pane", "read", pane, "--lines", "5"]);
				consecutiveReloadFailures = 0;
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				if (pane) {
					try {
						const lines = error?.code === "diag-timeout" ? "30" : "5";
						const paneRead = herdr(["pane", "read", pane, "--lines", lines]);
						errorMessage += `; pane tail: ${paneRead.trim().replace(/\s+/g, " ")}`;
					} catch {
						errorMessage += "; pane read failed";
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
			results.push({ run: index, startup_ms: startupMs, first_frame_ms: firstFrameMs, reload_ms: reloadMs, error: errorMessage });
		}

		const successful = (key) => results.map((runResult) => runResult[key]).filter((value) => typeof value === "number");
		const report = {
			commit: gitCommit(),
			generatedAt: new Date().toISOString(),
			scratchProject: scratch,
			runs: results,
			medians: {
				startup_ms: median(successful("startup_ms")),
				first_frame_ms: median(successful("first_frame_ms")),
				reload_ms: median(successful("reload_ms")),
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

run().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
