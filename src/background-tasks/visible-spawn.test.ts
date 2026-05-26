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

	it("buildVisibleAgentCommand launches sumocode directly without a wrapper", () => {
		const cmd = buildVisibleAgentCommand({
			cwd: "/repo with spaces",
			command: "Review the diff",
			runner: "sumocode",
		});

		expect(cmd).toBe("cd '/repo with spaces' && exec sumocode 'Review the diff'");
		expect(cmd).not.toContain("run.sh");
		expect(cmd).not.toContain("tee -a");
	});

	it("buildVisibleTaskCommand launches pi runner directly", () => {
		const paths = buildVisibleTaskPaths("bg-4", 456, "/tmp/test-bg");
		const cmd = buildVisibleTaskCommand({
			cwd: "/repo",
			command: "Review the diff",
			paths,
			taskId: "bg-4",
			runner: "pi",
		});

		expect(cmd).toBe("cd '/repo' && exec pi 'Review the diff'");
		expect(cmd).not.toContain("/tmp/test-bg/bg-4-456/run.sh");
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
