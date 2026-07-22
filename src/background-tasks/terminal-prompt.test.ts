import { describe, expect, it } from "vitest";
import { buildObservationResult, buildTerminalResultMessage, TERMINAL_TOOL_DESCRIPTIONS, TERMINAL_TOOL_GUIDELINES } from "./terminal-prompt.js";
import { TERMINAL_TASK_SCHEMA_VERSION, type TerminalTaskSnapshot } from "./task-types.js";

const task: TerminalTaskSnapshot = {
	schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
	revision: 3,
	id: "term-a",
	ownerSessionId: "session-a",
	command: "pnpm test",
	cwd: "/repo",
	title: "tests",
	status: "completed",
	completionPolicy: "passive",
	createdAt: 1_000,
	updatedAt: 2_000,
	settledAt: 2_000,
	exitCode: 0,
	deliveryState: "pending",
	completionId: "completion-a",
	pid: 42,
	processGroupId: 42,
	processStartTime: "start",
	logFile: "/tmp/term-a/output.log",
};

describe("terminal prompt guidance", () => {
	it("documents the five terminal verbs, passive default, and no stdin without bg guidance", () => {
		const guidance = [...TERMINAL_TOOL_GUIDELINES, ...Object.values(TERMINAL_TOOL_DESCRIPTIONS)].join("\n");
		for (const name of ["terminal_start", "terminal_check", "terminal_wait", "terminal_stop", "terminal_list"]) {
			expect(guidance).toContain(name);
		}
		expect(guidance).toContain("passive");
		expect(guidance).toContain("no stdin");
		const legacyPrefix = ["b", "g"].join("");
		expect(guidance).not.toContain(`${legacyPrefix}_start`);
		expect(guidance).not.toContain(`/${legacyPrefix}`);
	});

	it("sanitizes control sequences and bounds completion output", () => {
		const output = `\u001b[31msecret-looking output\u001b[0m\r${"x".repeat(20_000)}`;
		const observation = buildObservationResult({ task, output });
		const completion = buildTerminalResultMessage(task, output);

		expect(observation).not.toContain("\u001b");
		expect(completion).not.toContain("\u001b");
		expect(observation.length).toBeLessThan(17_500);
		expect(completion.length).toBeLessThan(9_500);
	});
});
