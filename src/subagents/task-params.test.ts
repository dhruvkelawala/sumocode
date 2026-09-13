import { describe, expect, it } from "vitest";
import { resolveModel } from "./task-params.js";

describe("subagent task params", () => {
	it("splits provider from a slash-bearing model id only at the first slash", () => {
		expect(resolveModel("openrouter/z-ai/glm-5.3", undefined)).toEqual({
			ok: true,
			model: {
				provider: "openrouter",
				modelId: "z-ai/glm-5.3",
				label: "openrouter/z-ai/glm-5.3",
			},
		});
	});

	it("rejects a model override without a provider prefix", () => {
		expect(resolveModel("gpt-5.5", undefined)).toMatchObject({ ok: false });
	});

	it("inherits the caller model when no override is given", () => {
		expect(resolveModel(undefined, { provider: "anthropic", id: "claude-sol" })).toEqual({
			ok: true,
			model: { provider: "anthropic", modelId: "claude-sol", label: "anthropic/claude-sol" },
		});
	});
});
