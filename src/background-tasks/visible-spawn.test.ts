import { describe, expect, it } from "vitest";
import {
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
		expect(paths.markerFile).toBe("/tmp/test-bg/bg-1-1700000000000/started.marker");
	});

	it("shell-escapes cwd in the cwd-missing diagnostic", () => {
		const paths = buildVisibleTaskPaths("bg-x", 1, "/tmp/test-bg");
		const script = buildVisibleTaskScript({
			cwd: "/repo/$(rm -rf /)/and-quotes",
			command: "pnpm test",
			paths,
			taskId: "bg-x",
		});

		expect(script).toContain("cd '/repo/$(rm -rf /)/and-quotes'");
		expect(script).toContain("echo '[sumocode-bg] task=bg-x cwd-missing: /repo/$(rm -rf /)/and-quotes'");
		expect(script).not.toContain('"$(rm');
		expect(script).not.toMatch(/cwd-missing:[^']*\$\(rm[^']*"/);
	});

	it("exports SUMOCODE_BG_CHILD to guard nested Pi invocations", () => {
		const paths = buildVisibleTaskPaths("bg-6", 999, "/tmp/test-bg");
		const script = buildVisibleTaskScript({ cwd: "/repo", command: "pnpm test", paths, taskId: "bg-6" });
		expect(script).toContain("export SUMOCODE_BG_CHILD=1");
	});

	it("runs only the wrapper script to keep panes readable", () => {
		const paths = buildVisibleTaskPaths("bg-2", 123, "/tmp/test-bg");
		const command = buildVisibleTaskCommand({
			cwd: "/Volumes/SumoDeus NVMe/code/sumocode",
			command: "pnpm test",
			paths,
			taskId: "bg-2",
		});

		expect(command).toBe("bash -l '/tmp/test-bg/bg-2-123/run.sh'");
		expect(command).not.toContain("pnpm test");
		expect(command).not.toContain("pipefail");
	});

	it("uses bash pipefail for visible shell tasks", () => {
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

	it("parses numeric exit codes", () => {
		expect(readExitCodeFromFile("0\n")).toBe(0);
		expect(readExitCodeFromFile("127")).toBe(127);
		expect(readExitCodeFromFile("nope")).toBeNull();
	});

	it("extracts task ids and exit codes from wrapper markers", () => {
		expect(parseExitMarkerLine("[sumocode-bg] task=bg-3 exit:1")).toEqual({ taskId: "bg-3", exitCode: 1 });
	});
});
