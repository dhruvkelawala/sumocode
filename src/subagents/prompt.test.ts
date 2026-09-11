import { describe, expect, it } from "vitest";
import { SUBAGENT_MAX_RUNNING } from "./domain.js";
import {
	buildSubagentPromptGuidelines,
	SUBAGENT_PROMPT_SNIPPET,
	SUBAGENT_TOOL_DESCRIPTIONS,
} from "./prompt.js";
import { BUILT_IN_ROLES, loadRoles, type SubagentRole } from "./roles.js";

const guidanceText = (roles: readonly SubagentRole[] = BUILT_IN_ROLES): string => buildSubagentPromptGuidelines(roles).join("\n");

describe("subagent prompt guidance", () => {
	it("distinguishes visible work from silent headless fan-out", () => {
		const guidance = guidanceText();
		expect(guidance).toContain("Use visible subagents for long or interactive work");
		expect(guidance).toContain("use headless subagents for silent, bounded fan-out");
		expect(guidance).toContain("Visible Herdr children split beside the parent when its tab is available");
		expect(SUBAGENT_PROMPT_SNIPPET).toContain("visible subagents");
	});

	it("teaches fire-and-forget role delegation and demotes waiting", () => {
		const guidance = guidanceText();
		expect(guidance).toContain("delegation is fire-and-forget");
		expect(guidance).toContain("do NOT call subagent_wait right after subagent_spawn");
		expect(guidance).toContain("research, review, documentor, designer, implement-cheap, implement-smart");
		expect(guidance).toContain("status=queued");
		expect(guidance).toContain(`At most ${SUBAGENT_MAX_RUNNING} subagents can run concurrently.`);
		expect(SUBAGENT_TOOL_DESCRIPTIONS.wait).toContain("Last resort");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.wait).toContain("prefer ending your turn");
	});

	it("documents the isolated coding-task recipe with worktree and baseRef", () => {
		const guidance = guidanceText();
		expect(guidance).toContain("To delegate a self-contained coding task");
		expect(guidance).toContain("worktree: true");
		expect(guidance).toContain("baseRef: 'origin/main'");
		expect(guidance).toContain("completion manifest");
	});

	it("documents steering acknowledgement bounds and the close/auto-close lifecycle", () => {
		const guidance = guidanceText();
		expect(guidance).toContain("Use subagent_send to steer a running visible child");
		// Bounded success claim: consumption + synchronous submission, nothing more.
		expect(guidance).toContain("consumed the control and synchronously submitted it to Pi");
		expect(guidance).toContain("exposes no post-acceptance acknowledgement");
		// The delivery claim appears only inside an explicit negation, never as a
		// bare promise.
		expect(guidance).toMatch(/does not prove the text was delivered as a Pi steering message/);
		expect(guidance).toContain("not typed into its terminal");
		expect(guidance).toContain("Headless or settled children cannot receive input");
		expect(guidance).toContain("visible children stay open while active and auto-close after 30s of silence");
		expect(guidance).toContain("use subagent_close to end one deliberately");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.send).toContain("control consumption and synchronous submission");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.send).toContain("not model-turn acceptance");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.send).toContain("not typed into its terminal");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.close).toContain("Gracefully close visible subagents");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.close).toContain("Use subagent_cancel only to abort work");
		expect(SUBAGENT_TOOL_DESCRIPTIONS.spawn).toContain("visible=true");
	});

	it("teaches role isolation defaults and the dirty-checkout visibility boundary", () => {
		const guidance = guidanceText();
		expect(guidance).toContain("research → inherit (shared checkout)");
		expect(guidance).toContain("implement-smart → inherit (worktree)");
		expect(guidance).toContain("worktree children branch from committed HEAD");
		expect(guidance).toContain("run checks of uncommitted edits in the parent, not in a worktree child");
	});

	it("names one of the two implement roles in every coding delegation", () => {
		const guidance = guidanceText();
		expect(guidance).toContain('role: "implement-smart" | "implement-cheap"');
		expect(guidance).toContain("Every coding delegation picks one of the two implement roles");
	});

	it("prints the resolved model and worktree default for an overlaid role", () => {
		const loaded = loadRoles({ readFile: () => JSON.stringify({ roles: [{ id: "implement-smart", model: "openai-codex/gpt-5.6-sol" }] }), env: { PI_CODING_AGENT_DIR: "/agent" } });
		const guidance = guidanceText(loaded.roles);
		expect(guidance).toContain("implement-smart → openai-codex/gpt-5.6-sol (worktree)");
		expect(guidance).toContain("research → inherit (shared checkout)");
	});

	it("keeps the model guarantee for the child's own work", () => {
		const guidance = guidanceText();
		expect(guidance).toContain("the child's model IS the implementer's model");
		expect(guidance).toContain("do not assume your own model or a reviewer will write the code");
		expect(guidance).toContain("an explicit `worktree:false` plus `working_dir` overrides a role's worktree default");
	});

	it("teaches how to consume a settled worktree child's manifest", () => {
		const guidance = guidanceText();
		expect(guidance).toContain("read its completion manifest before acting");
		expect(guidance).toContain("+0 commits means nothing to apply");
		expect(guidance).toContain("merge or cherry-pick its sumo/<branch> from the preserved worktree path");
		expect(guidance).toContain("removing one requires explicit user approval");
	});
});
