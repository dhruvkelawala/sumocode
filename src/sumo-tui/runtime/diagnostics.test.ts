import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logDiagnostic, logRuntimeStart } from "./diagnostics.js";

const previousDiagFile = process.env.SUMO_TUI_DIAG_FILE;
const previousBranch = process.env.SUMOCODE_DEBUG_BRANCH;
const previousCommit = process.env.SUMOCODE_DEBUG_COMMIT;
const previousPublicStartupDiagnostics = process.env.SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS;
let tempDir: string | undefined;

afterEach(() => {
	if (previousDiagFile === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
	else process.env.SUMO_TUI_DIAG_FILE = previousDiagFile;
	if (previousBranch === undefined) delete process.env.SUMOCODE_DEBUG_BRANCH;
	else process.env.SUMOCODE_DEBUG_BRANCH = previousBranch;
	if (previousCommit === undefined) delete process.env.SUMOCODE_DEBUG_COMMIT;
	else process.env.SUMOCODE_DEBUG_COMMIT = previousCommit;
	if (previousPublicStartupDiagnostics === undefined) delete process.env.SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS;
	else process.env.SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS = previousPublicStartupDiagnostics;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function useDiagFile(): string {
	tempDir = mkdtempSync(join(tmpdir(), "sumocode-diag-"));
	const file = join(tempDir, "manual.jsonl");
	process.env.SUMO_TUI_DIAG_FILE = file;
	return file;
}

describe("diagnostics", () => {
	it("writes sanitized JSONL events only when SUMO_TUI_DIAG_FILE is set", () => {
		const file = useDiagFile();
		logDiagnostic("example", { text: "x".repeat(200), nested: { ok: true }, list: ["a", "b"] });

		const [line] = readFileSync(file, "utf8").trim().split("\n");
		const event = JSON.parse(line!);
		expect(event.event).toBe("example");
		expect(event.text.length).toBeLessThan(200);
		expect(event.nested).toEqual({ ok: true });
		expect(event.list).toEqual(["a", "b"]);
	});

	it("creates the trace file readable by its owner only", () => {
		const file = useDiagFile();
		logDiagnostic("mode_check");

		expect(existsSync(file)).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it("stays a no-op when SUMO_TUI_DIAG_FILE is unset", () => {
		tempDir = mkdtempSync(join(tmpdir(), "sumocode-diag-"));
		const file = join(tempDir, "manual.jsonl");
		delete process.env.SUMO_TUI_DIAG_FILE;

		logDiagnostic("ignored", { value: 1 });

		expect(existsSync(file)).toBe(false);
	});

	it("whitelists public startup events and strips diagnostic fields", () => {
		const file = useDiagFile();
		process.env.SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS = "1";

		logDiagnostic("runtime_start", { cwd: "/Users/operator/project" });
		logDiagnostic("rpc_child_ready", { surface: "rpc_host", cwd: "/Users/operator/project" });
		logDiagnostic("terminal_index_ready", { durationMs: 0.08, snapshotCount: 1800, cwd: "/Users/operator/project" });

		const events = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(events).toEqual([
			expect.objectContaining({ event: "rpc_child_ready" }),
			expect.objectContaining({ event: "terminal_index_ready", durationMs: 0.08 }),
		]);
		expect(events[0]).not.toHaveProperty("cwd");
		expect(events[0]).not.toHaveProperty("surface");
		expect(events[1]).not.toHaveProperty("cwd");
		expect(events[1]).toHaveProperty("snapshotCount", 1800);
	});

	it("records runtime branch and commit metadata", () => {
		const file = useDiagFile();
		process.env.SUMOCODE_DEBUG_BRANCH = "feat/debug-mode-diagnostics";
		process.env.SUMOCODE_DEBUG_COMMIT = "abc123 fix(test): sample";

		logRuntimeStart({ terminal: { columns: 120, rows: 40, isTTY: true } });

		const event = JSON.parse(readFileSync(file, "utf8").trim());
		expect(event.event).toBe("runtime_start");
		expect(event.branch).toBe("feat/debug-mode-diagnostics");
		expect(event.commit).toBe("abc123 fix(test): sample");
		expect(event.terminal).toEqual({ columns: 120, rows: 40, isTTY: true });
	});
});
