import { describe, expect, it } from "vitest";
import {
	buildVisibleAgentCommand,
	buildVisibleTaskCommand,
	buildVisibleTaskPaths,
	buildVisibleTaskScript,
	parseExitMarkerLine,
	readExitCodeFromFile,
} from "./visible-spawn.js";

describe("visible-spawn", () => {
	it("buildVisibleTaskPaths uses task id and timestamp", () => {
		const paths = buildVisibleTaskPaths("bg-1", 1_700_000_000_000, "/tmp/test-bg");
		expect(paths.logFile).toBe("/tmp/test-bg/bg-1-1700000000000/output.log");
		expect(paths.exitFile).toBe("/tmp/test-bg/bg-1-1700000000000/exit.code");
		expect(paths.scriptFile).toBe("/tmp/test-bg/bg-1-1700000000000/run.sh");
		expect(paths.metaFile).toBe("/tmp/test-bg/bg-1-1700000000000/meta.json");
		expect(paths.promptFile).toBe("/tmp/test-bg/bg-1-1700000000000/prompt.txt");
		expect(paths.responseFile).toBe("/tmp/test-bg/bg-1-1700000000000/response.md");
		expect(paths.diagFile).toBe("/tmp/test-bg/bg-1-1700000000000/diag.jsonl");
	});

	it("buildVisibleTaskScript shell-escapes cwd in the cwd-missing echo (no command substitution)", () => {
		// A cwd containing $(...) or backticks must NOT be evaluated at run.sh
		// execution time. Without escaping, bash would expand the substitution
		// in the diagnostic echo and could execute arbitrary code.
		const paths = buildVisibleTaskPaths("bg-x", 1, "/tmp/test-bg");
		const script = buildVisibleTaskScript({
			cwd: "/repo/$(rm -rf /)/and-quotes",
			command: "pnpm test",
			paths,
			taskId: "bg-x",
		});

		// The dangerous substring must only appear inside single-quoted segments.
		// shellEscape wraps both the cwd and the diagnostic echo in '...', so
		// bash treats $(rm -rf /) as a literal.
		expect(script).toContain("cd '/repo/$(rm -rf /)/and-quotes'");
		expect(script).toContain("echo '[sumocode-bg] task=bg-x cwd-missing: /repo/$(rm -rf /)/and-quotes'");
		// No DOUBLE-quoted occurrence (which would let bash expand the substitution).
		expect(script).not.toContain('"$(rm');
		expect(script).not.toMatch(/cwd-missing:[^']*\$\(rm[^']*"/);
	});

	it("buildVisibleTaskScript exports SUMOCODE_BG_CHILD to guard nested pi/sumocode invocations", () => {
		const paths = buildVisibleTaskPaths("bg-6", 999, "/tmp/test-bg");
		const script = buildVisibleTaskScript({
			cwd: "/repo",
			command: "pnpm test",
			paths,
			taskId: "bg-6",
		});

		expect(script).toContain("export SUMOCODE_BG_CHILD=1");
	});

	it("buildVisibleTaskCommand runs only the wrapper script to keep cmux panes readable", () => {
		const paths = buildVisibleTaskPaths("bg-2", 123, "/tmp/test-bg");
		const cmd = buildVisibleTaskCommand({
			cwd: "/Volumes/SumoDeus NVMe/code/sumocode",
			command: "pnpm test",
			paths,
			taskId: "bg-2",
		});

		expect(cmd).toBe("exec bash '/tmp/test-bg/bg-2-123/run.sh'");
		expect(cmd).not.toContain("pnpm test");
		expect(cmd).not.toContain("pipefail");
	});

	it("buildVisibleTaskScript uses bash pipefail for shell tasks", () => {
		const paths = buildVisibleTaskPaths("bg-2", 123, "/tmp/test-bg");
		const script = buildVisibleTaskScript({
			cwd: "/Volumes/SumoDeus NVMe/code/sumocode",
			command: "pnpm test",
			paths,
			taskId: "bg-2",
		});

		expect(script).toContain("#!/usr/bin/env bash");
		expect(script).toContain("set -o pipefail");
		expect(script).toContain("pnpm test");
		expect(script).toContain("[sumocode-bg] task=bg-2 exit:$code");
	});

	it("buildVisibleAgentCommand routes sumocode through --prompt-file with response harvest env vars", () => {
		const paths = buildVisibleTaskPaths("bg-4", 456, "/tmp/test-bg");
		const cmd = buildVisibleAgentCommand({
			cwd: "/repo with spaces",
			runner: "sumocode",
			paths,
		});

		expect(cmd).toBe(
			"cd '/repo with spaces' && " +
				"SUMOCODE_TASK_RESPONSE_FILE='/tmp/test-bg/bg-4-456/response.md' " +
				"SUMOCODE_TASK_DIAG_FILE='/tmp/test-bg/bg-4-456/diag.jsonl' " +
				"exec sumocode task --prompt-file '/tmp/test-bg/bg-4-456/prompt.txt'",
		);
		expect(cmd).not.toContain("run.sh");
		expect(cmd).not.toContain("tee -a");
	});

	it("buildVisibleAgentCommand forwards model and thinking flags to sumocode", () => {
		const paths = buildVisibleTaskPaths("bg-7", 789, "/tmp/test-bg");
		const cmd = buildVisibleAgentCommand({
			cwd: "/repo",
			runner: "sumocode",
			paths,
			model: "openai/gpt-4o-mini",
			thinking: "low",
		});

		expect(cmd).toContain("--model 'openai/gpt-4o-mini'");
		expect(cmd).toContain("--thinking 'low'");
		// Flags must precede --prompt-file so the wrapper forwards them to pi as
		// options before the positional message.
		const modelIdx = cmd.indexOf("--model");
		const promptIdx = cmd.indexOf("--prompt-file");
		expect(modelIdx).toBeLessThan(promptIdx);
	});

	it("buildVisibleAgentCommand rejects unsupported runners (e.g. bare 'pi') with a clear error", () => {
		const paths = buildVisibleTaskPaths("bg-x", 1, "/tmp/test-bg");
		expect(() =>
			buildVisibleAgentCommand({
				cwd: "/repo",
				// @ts-expect-error — 'pi' was removed as a supported runner; this guards regressions.
				runner: "pi",
				paths,
			}),
		).toThrow(/sumocode/);
	});

	it("buildVisibleTaskScript rejects agent runners", () => {
		const paths = buildVisibleTaskPaths("bg-5", 789, "/tmp/test-bg");
		expect(() =>
			buildVisibleTaskScript({
				cwd: "/repo",
				command: "Review the diff",
				paths,
				taskId: "bg-5",
				runner: "sumocode",
			}),
		).toThrow(/launch directly/i);
	});

	it("readExitCodeFromFile parses numeric exit codes", () => {
		expect(readExitCodeFromFile("0\n")).toBe(0);
		expect(readExitCodeFromFile("127")).toBe(127);
		expect(readExitCodeFromFile("nope")).toBeNull();
	});

	it("parseExitMarkerLine extracts task id and exit code", () => {
		expect(parseExitMarkerLine("[sumocode-bg] task=bg-3 exit:1")).toEqual({
			taskId: "bg-3",
			exitCode: 1,
		});
	});
});
