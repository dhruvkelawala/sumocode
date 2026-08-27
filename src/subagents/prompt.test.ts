import { describe, expect, it } from "vitest";
import { SUBAGENT_MAX_RUNNING } from "./domain.js";
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
		expect(guidance).toContain("Visible Herdr children split beside the parent when its tab is available");
		expect(SUBAGENT_PROMPT_SNIPPET).toContain("visible subagents");
	});

	it("teaches fire-and-forget role delegation and demotes waiting", () => {
		const guidance = SUBAGENT_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("delegation is fire-and-forget");
		expect(guidance).toContain("do NOT call subagent_wait right after subagent_spawn");
		expect(guidance).toContain("research, review, documentor, designer, implement-cheap, implement-smart");
		expect(guidance).toContain("status=queued");
		expect(guidance).toContain(`At most ${SUBAGENT_MAX_RUNNING} subagents can run concurrently.`);
		expect(SUBAGENT_TOOL_DESCRIPTIONS.wait).toContain("Last resort");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.wait).toContain("prefer ending your turn");
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

	it("teaches role isolation defaults and the dirty-checkout visibility boundary", () => {
		const guidance = SUBAGENT_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("research and review run in the shared checkout");
		expect(guidance).toContain("documentor, designer, and the implement roles default to isolated worktrees");
		expect(guidance).toContain("worktree children branch from committed HEAD");
		expect(guidance).toContain("run checks of uncommitted edits in the parent, not in a worktree child");
	});

	it("teaches how to consume a settled worktree child's manifest", () => {
		const guidance = SUBAGENT_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("read its completion manifest before acting");
		expect(guidance).toContain("+0 commits means nothing to apply");
		expect(guidance).toContain("merge or cherry-pick its sumo/<branch> from the preserved worktree path");
		expect(guidance).toContain("removing one requires explicit user approval");
	});
});
