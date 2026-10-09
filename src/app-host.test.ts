import { describe, expect, it } from "vitest";
import { buildT3RoleGuidance, hasT3Orchestration, isAppHostProfile } from "./app-host.js";
import { BUILT_IN_ROLES } from "./subagents/roles.js";

describe("app host detection", () => {
	it("selects the app host profile only for the sumocode-pi-cli marker", () => {
		expect(isAppHostProfile({ SUMOCODE_APP_HOST: "1" })).toBe(true);
		expect(isAppHostProfile({})).toBe(false);
		expect(isAppHostProfile({ SUMOCODE_APP_HOST: "0" })).toBe(false);
		// T3's own variables do not select the profile: its discovery probe runs without them.
		expect(isAppHostProfile({ T3_MCP_URL: "http://127.0.0.1:1/mcp", T3_MCP_BEARER_TOKEN: "token" })).toBe(false);
	});

	it("reports T3 orchestration only when the bridge has both its endpoint and token", () => {
		expect(hasT3Orchestration({ T3_MCP_URL: "http://127.0.0.1:1/mcp", T3_MCP_BEARER_TOKEN: "token" })).toBe(true);
		expect(hasT3Orchestration({ T3_MCP_URL: "http://127.0.0.1:1/mcp" })).toBe(false);
		expect(hasT3Orchestration({ T3_MCP_BEARER_TOKEN: "token" })).toBe(false);
		expect(hasT3Orchestration({ T3_PI_RUNTIME_MODE: "full-access" })).toBe(false);
	});
});

describe("T3 role guidance", () => {
	it("maps every role to a delegate_task target with its instructions", () => {
		const guidance = buildT3RoleGuidance([
			{ id: "research", label: "Research", description: "", systemPrompt: "investigate read-only." },
			{ id: "implement-smart", label: "Implement", description: "", systemPrompt: "implement with judgment.", model: "openai-codex/gpt-6.1-sol", defaultWorktree: true },
		]);

		expect(guidance).toContain("`target.providerInstanceId` to the Pi provider instance (driverKind `pi` in `orchestrator_capabilities`)");
		expect(guidance).toContain("- research (inherits your model): investigate read-only.");
		expect(guidance).toContain("- implement-smart (model openai-codex/gpt-6.1-sol): implement with judgment.");
		expect(guidance).toContain("SumoCode would isolate implement-smart in a git worktree");
	});

	it("omits the shared-checkout note when no role isolates", () => {
		const guidance = buildT3RoleGuidance(BUILT_IN_ROLES.filter((role) => role.defaultWorktree !== true));

		expect(guidance).not.toContain("git worktree");
	});
});
