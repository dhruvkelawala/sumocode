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
			command: "A long prompt with 'quotes', colons:, $vars, `backticks`, and multi-line\ncontent that would otherwise echo as a wall of text in the cmux pane.",
			runner: "sumocode",
			paths,
		});

		expect(cmd).toBe(
			"cd '/repo with spaces' && " +
				"SUMOCODE_TASK_RESPONSE_FILE='/tmp/test-bg/bg-4-456/response.md' " +
				"SUMOCODE_TASK_DIAG_FILE='/tmp/test-bg/bg-4-456/diag.jsonl' " +
				"exec sumocode task --prompt-file '/tmp/test-bg/bg-4-456/prompt.txt'",
		);
		// Prompt contents must NOT appear in the cmux respawn command — that's
		// the whole point of file-based passing.
		expect(cmd).not.toContain("quotes");
		expect(cmd).not.toContain("backticks");
		expect(cmd).not.toContain("wall of text");
		expect(cmd).not.toContain("run.sh");
		expect(cmd).not.toContain("tee -a");
	});

	it("buildVisibleAgentCommand forwards model and thinking flags to sumocode", () => {
		const paths = buildVisibleTaskPaths("bg-7", 789, "/tmp/test-bg");
		const cmd = buildVisibleAgentCommand({
			cwd: "/repo",
			command: "review diff",
			runner: "sumocode",
			paths,
			model: "openai/gpt-4o-mini",
			thinking: "low",
		});

		expect(cmd).toContain("--model 'openai/gpt-4o-mini'");
		expect(cmd).toContain("--thinking 'low'");
		// Flags must precede --prompt-file so pi sees them as options not messages.
		const modelIdx = cmd.indexOf("--model");
		const promptIdx = cmd.indexOf("--prompt-file");
		expect(modelIdx).toBeLessThan(promptIdx);
	});

	it("buildVisibleTaskCommand launches pi runner with prompt as kickoff message (inline, no prompt file)", () => {
		const paths = buildVisibleTaskPaths("bg-5", 456, "/tmp/test-bg");
		const cmd = buildVisibleTaskCommand({
			cwd: "/repo",
			command: "Review the diff",
			paths,
			taskId: "bg-5",
			runner: "pi",
		});

		expect(cmd).toBe(
			"cd '/repo' && " +
				"SUMOCODE_TASK_RESPONSE_FILE='/tmp/test-bg/bg-5-456/response.md' " +
				"SUMOCODE_TASK_DIAG_FILE='/tmp/test-bg/bg-5-456/diag.jsonl' " +
				"exec pi 'Review the diff'",
		);
		expect(cmd).not.toContain("/tmp/test-bg/bg-5-456/run.sh");
	});

	it("buildVisibleAgentCommand forwards model and thinking flags to pi runner before the inline prompt", () => {
		const paths = buildVisibleTaskPaths("bg-8", 100, "/tmp/test-bg");
		const cmd = buildVisibleAgentCommand({
			cwd: "/repo",
			command: "summarize",
			runner: "pi",
			paths,
			model: "anthropic/claude-sonnet-4-5",
			thinking: "high",
		});

		expect(cmd).toContain("--model 'anthropic/claude-sonnet-4-5'");
		expect(cmd).toContain("--thinking 'high'");
		const modelIdx = cmd.indexOf("--model");
		const promptIdx = cmd.indexOf("'summarize'");
		expect(modelIdx).toBeLessThan(promptIdx);
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
