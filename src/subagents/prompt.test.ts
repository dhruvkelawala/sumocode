import { describe, expect, it } from "vitest";
import {
	SUBAGENT_PROMPT_GUIDELINES,
	SUBAGENT_PROMPT_SNIPPET,
	SUBAGENT_TOOL_DESCRIPTIONS,
} from "./prompt.js";

describe("subagent prompt guidance", () => {
	it("distinguishes visible work from silent headless fan-out", () => {
		const guidance = SUBAGENT_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("Use visible subagents for long or interactive work");
		expect(guidance).toContain("use headless subagents for silent, bounded fan-out");
		expect(guidance).toContain("Visible isolated children appear as herdr workspaces");
		expect(guidance).toContain("non-isolated visible children tile into a subagents tab");
		expect(SUBAGENT_PROMPT_SNIPPET).toContain("visible subagents");
	});

	it("documents the isolated coding-task recipe with worktree and baseRef", () => {
		const guidance = SUBAGENT_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("To delegate a self-contained coding task");
		expect(guidance).toContain("worktree: true");
		expect(guidance).toContain("baseRef: 'origin/main'");
		expect(guidance).toContain("completion manifest");
	});

	it("documents pane steering and its visible-only boundary", () => {
		const guidance = SUBAGENT_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("Use subagent_send to steer a running visible child");
		expect(guidance).toContain("Headless or settled children cannot receive input");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.send).toContain("followed by Enter");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.spawn).toContain("visible=true");
	});
});
