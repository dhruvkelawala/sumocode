import { describe, expect, it } from "vitest";
import {
	buildVisibleTaskCommand,
	buildVisibleTaskPaths,
	parseExitMarkerLine,
	readExitCodeFromFile,
} from "./visible-spawn.js";

describe("visible-spawn spike", () => {
	it("buildVisibleTaskPaths uses task id and timestamp", () => {
		const paths = buildVisibleTaskPaths("bg-1", 1_700_000_000_000, "/tmp/test-bg");
		expect(paths.logFile).toBe("/tmp/test-bg/bg-1-1700000000000/output.log");
		expect(paths.exitFile).toBe("/tmp/test-bg/bg-1-1700000000000/exit.code");
		expect(paths.markerFile).toBe("/tmp/test-bg/bg-1-1700000000000/started.marker");
	});

	it("buildVisibleTaskCommand wraps command with tee and exit marker", () => {
		const paths = buildVisibleTaskPaths("bg-2", 123, "/tmp/test-bg");
		const cmd = buildVisibleTaskCommand({
			cwd: "/Volumes/SumoDeus NVMe/code/sumocode",
			command: "pnpm test",
			paths,
			taskId: "bg-2",
		});

		expect(cmd).toContain("cd '/Volumes/SumoDeus NVMe/code/sumocode'");
		expect(cmd).toContain("pnpm test");
		expect(cmd).toContain("tee -a");
		expect(cmd).toContain("exit.code");
		expect(cmd).toContain("[sumocode-bg] task=bg-2 started");
		expect(cmd).toContain("[sumocode-bg] task=bg-2 exit:$code");
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
		expect(parseExitMarkerLine("[sumocode-bg] task=bg-3 started")).toBeNull();
	});
});
