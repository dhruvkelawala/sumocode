import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLES, type SubagentRole } from "./subagents/roles.js";
import { generateTaskTitle, parseTaskTitle, type TaskTitleContext, taskPromptText } from "./session-task-name.js";

describe("taskPromptText", () => {
	it("collapses expanded skill blocks to their name", () => {
		expect(taskPromptText('<skill name="eli25" location="/x/SKILL.md">\nlong body\n</skill>\n\nfor #486')).toBe("/eli25\n\nfor #486");
	});
});

describe("parseTaskTitle", () => {
	it("keeps a clean short label", () => {
		expect(parseTaskTitle("v0.8 consumer fix")).toBe("v0.8 consumer fix");
	});

	it("strips quotes, trailing punctuation, and extra lines", () => {
		expect(parseTaskTitle('"Herdr task naming."\nbecause the prompt asks')).toBe("Herdr task naming");
	});

	it("caps words and length at a word boundary", () => {
		expect(parseTaskTitle("one two three four five")).toBe("one two three four");
		expect(parseTaskTitle("extraordinarily-long-identifier another-long-word")).toBe("extraordinarily-long-identifier");
		expect(parseTaskTitle(`${"x".repeat(40)} tail`)).toBe("x".repeat(32));
	});

	it("rejects empty replies", () => {
		expect(parseTaskTitle("  \n")).toBeUndefined();
	});
});

describe("generateTaskTitle", () => {
	const sessionModel = { provider: "anthropic", id: "session-model" };
	function harness(cheapModel: string | undefined) {
		const find = vi.fn((provider: string, id: string) => ({ provider, id }));
		type Complete = TaskTitleContext["modelRegistry"]["complete"];
		const complete = vi.fn<(...args: Parameters<Complete>) => Promise<{ content: Array<{ type: "text"; text: string }> }>>(
			async () => ({ content: [{ type: "text", text: "billing cron migration" }] }),
		);
		const double = { model: sessionModel, modelRegistry: { find, complete }, sessionManager: { getSessionId: () => "s1" } };
		// SAFETY: the double supplies the model/modelRegistry/sessionManager members generateTaskTitle reads.
		const ctx: TaskTitleContext = double as never;
		const roles: SubagentRole[] = BUILT_IN_ROLES.map((role) => (role.id === "implement-cheap" ? { ...role, model: cheapModel } : role));
		return { ctx, find, complete, loadRoles: () => ({ roles, warnings: [] }) };
	}

	it("uses the implement-cheap role model with a bounded, session-routed request", async () => {
		const h = harness("opencode-go/deepseek-v4.1-flash");
		await expect(generateTaskTitle("migrate the billing cron", h.ctx, h.loadRoles)).resolves.toBe("billing cron migration");
		expect(h.find).toHaveBeenCalledWith("opencode-go", "deepseek-v4.1-flash");
		expect(h.complete.mock.calls[0]?.[2]).toMatchObject({ sessionId: "s1:task-title", signal: expect.any(AbortSignal) });
	});

	it("falls back to the session model when the role has none, like a subagent would", async () => {
		const h = harness(undefined);
		await generateTaskTitle("migrate the billing cron", h.ctx, h.loadRoles);
		expect(h.find).toHaveBeenCalledWith("anthropic", "session-model");
	});
});
