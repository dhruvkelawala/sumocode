import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
	claudeAccountLabel,
	formatClaudeAccountChip,
	resolveClaudeAccountStatus,
} from "./claude-account-status.js";

function model(provider: string, id = "claude-opus-5"): Model<never> {
	// SAFETY: the resolver reads only provider/id; the rest of the Model shape is irrelevant here.
	return { provider, id } as never;
}

describe("claudeAccountLabel", () => {
	it("labels the built-in provider default", () => {
		expect(claudeAccountLabel("anthropic", "Anthropic")).toBe("default");
	});

	it("reads the subscription label out of the registered provider name", () => {
		expect(claudeAccountLabel("anthropic-2", "Claude (company)")).toBe("company");
		expect(claudeAccountLabel("anthropic-3", "Claude (Work Account)")).toBe("Work Account");
	});

	it("falls back to the account number, then the provider id", () => {
		expect(claudeAccountLabel("anthropic-2", "Claude #2")).toBe("#2");
		expect(claudeAccountLabel("anthropic-2", undefined)).toBe("#2");
		expect(claudeAccountLabel("anthropic-42", "Weird Name")).toBe("#42");
	});
});

describe("formatClaudeAccountChip", () => {
	it("renders the lowercase chip", () => {
		expect(formatClaudeAccountChip({ providerId: "anthropic-2", label: "company", active: false })).toBe("claude company");
	});

	it("clips a long label to the eight-column budget", () => {
		expect(formatClaudeAccountChip({ providerId: "anthropic-2", label: "work-account", active: false })).toBe("claude work-ac…");
		expect(formatClaudeAccountChip({ providerId: "anthropic-2", label: "personal", active: false })).toBe("claude personal");
	});
});

describe("resolveClaudeAccountStatus", () => {
	it("returns undefined when no Claude model is reachable", () => {
		expect(resolveClaudeAccountStatus({ models: [model("openai-codex", "gpt-5.6")] })).toBeUndefined();
		expect(resolveClaudeAccountStatus({ models: [] })).toBeUndefined();
	});

	it("resolves the first Claude model to its account when the current model is not Claude", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic"), model("anthropic-2")],
			currentProvider: "openai-codex",
			providerName: (providerId) => (providerId === "anthropic-2" ? "Claude (company)" : "Anthropic"),
		});
		expect(status).toEqual({ providerId: "anthropic", label: "default", active: false });
	});

	it("resolves an extra account when the base provider is not available", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic-2")],
			currentProvider: "deepseek",
			providerName: () => "Claude (company)",
		});
		expect(status).toEqual({ providerId: "anthropic-2", label: "company", active: false });
	});

	it("reports the live account as active when the current model is Claude", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic"), model("anthropic-2")],
			currentProvider: "anthropic-2",
			providerName: () => "Claude (company)",
		});
		expect(status).toEqual({ providerId: "anthropic-2", label: "company", active: true });
	});

	it("ignores a live Claude provider that has no reachable model", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic-2")],
			currentProvider: "anthropic",
			providerName: () => "Claude (company)",
		});
		expect(status).toEqual({ providerId: "anthropic-2", label: "company", active: false });
	});

	it("reads the provider name once per call", () => {
		const providerName = vi.fn(() => "Claude (company)");
		resolveClaudeAccountStatus({ models: [model("anthropic-2")], currentProvider: "openai", providerName });
		expect(providerName).toHaveBeenCalledTimes(1);
		expect(providerName).toHaveBeenCalledWith("anthropic-2");
	});
});
