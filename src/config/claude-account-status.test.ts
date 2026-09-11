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
		expect(claudeAccountLabel("anthropic", "personal")).toBe("default");
	});

	it("lowercases the subscription label", () => {
		expect(claudeAccountLabel("anthropic-2", "company")).toBe("company");
		expect(claudeAccountLabel("anthropic-3", "Work Account")).toBe("work account");
	});

	it("falls back to the account number, then the provider id", () => {
		expect(claudeAccountLabel("anthropic-2", undefined)).toBe("#2");
		expect(claudeAccountLabel("anthropic-42", "")).toBe("#42");
		expect(claudeAccountLabel("custom-provider", undefined)).toBe("custom-provider");
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
			subscriptionLabel: (providerId) => (providerId === "anthropic-2" ? "company" : undefined),
		});
		expect(status).toEqual({ providerId: "anthropic", label: "default", active: false });
	});

	it("resolves an extra account when the base provider is not available", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic-2")],
			currentProvider: "deepseek",
			subscriptionLabel: () => "company",
		});
		expect(status).toEqual({ providerId: "anthropic-2", label: "company", active: false });
	});

	it("reports the live account as active when the current model is Claude", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic"), model("anthropic-2")],
			currentProvider: "anthropic-2",
			subscriptionLabel: () => "company",
		});
		expect(status).toEqual({ providerId: "anthropic-2", label: "company", active: true });
	});

	it("ignores a live Claude provider that has no reachable model", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic-2")],
			currentProvider: "anthropic",
			subscriptionLabel: () => "company",
		});
		expect(status).toEqual({ providerId: "anthropic-2", label: "company", active: false });
	});

	it("reads the subscription label once per call", () => {
		const subscriptionLabel = vi.fn(() => "company");
		resolveClaudeAccountStatus({ models: [model("anthropic-2")], currentProvider: "openai", subscriptionLabel });
		expect(subscriptionLabel).toHaveBeenCalledTimes(1);
		expect(subscriptionLabel).toHaveBeenCalledWith("anthropic-2");
	});

	it("orders accounts explicitly: base first, then by index, not by registry order", () => {
		const status = resolveClaudeAccountStatus({
			models: [model("anthropic-3"), model("anthropic-2"), model("anthropic")],
			currentProvider: "openai-codex",
		});
		expect(status?.providerId).toBe("anthropic");

		const withoutBase = resolveClaudeAccountStatus({
			models: [model("anthropic-3"), model("anthropic-2")],
			currentProvider: "openai-codex",
		});
		expect(withoutBase?.providerId).toBe("anthropic-2");
	});
});
