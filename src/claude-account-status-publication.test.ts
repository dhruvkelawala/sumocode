import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
/* oxlint-disable anti-slop/no-chained-type-assertions -- test doubles cast minimal stub objects to the Pi context and API types the installer reads. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY,
	CLAUDE_ACCOUNT_STATUS_KEY,
	hasPublishedClaudeAccount,
	installClaudeAccountStatus,
	publishClaudeAccountStatus,
	resolveSessionClaudeAccount,
} from "./claude-account-status-publication.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** Hermetic agent dir: the resolver reads enabledModels from there. */
function agentDirWithClaudeEnabled(): string {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-account-publish-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["claude-*"] }), "utf8");
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	return dir;
}

interface CtxOptions {
	readonly provider?: string;
	readonly models?: readonly { provider: string; id: string }[];
	readonly hasUI?: boolean;
}

function ctxWith(options: CtxOptions = {}) {
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
		modelRegistry: { getAvailable: () => options.models ?? [] },
		model: options.provider ? { id: "claude-opus-5", provider: options.provider } : undefined,
	};
	// SAFETY: the double supplies every surface the resolver and publisher read.
	return { ctx: ctx as never as ExtensionContext, statuses };
}

function installHarness() {
	const handlers = new Map<string, Array<(event: { type: string }, ctx: ExtensionContext) => void>>();
	const pi = {
		on: vi.fn((name: string, handler: (event: { type: string }, ctx: ExtensionContext) => void) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		}),
	};
	// SAFETY: the double supplies the on() surface the installer reads.
	installClaudeAccountStatus(pi as never as ExtensionAPI, { subscriptionLabel: () => "company" });
	return {
		fire(name: string, ctx: ExtensionContext): void {
			for (const handler of handlers.get(name) ?? []) handler({ type: name }, ctx);
		},
		handlers,
	};
}

describe("hasPublishedClaudeAccount", () => {
	it("reads the active key first, then the dim key", () => {
		expect(hasPublishedClaudeAccount(new Map([[CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY, "company"]]))).toEqual({ label: "company", active: true });
		expect(hasPublishedClaudeAccount(new Map([[CLAUDE_ACCOUNT_STATUS_KEY, "company"]]))).toEqual({ label: "company", active: false });
	});

	it("prefers the active label when both keys linger", () => {
		const statuses = new Map([
			[CLAUDE_ACCOUNT_STATUS_KEY, "default"],
			[CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY, "company"],
		]);
		expect(hasPublishedClaudeAccount(statuses)).toEqual({ label: "company", active: true });
	});

	it("returns undefined with no statuses", () => {
		expect(hasPublishedClaudeAccount(undefined)).toBeUndefined();
		expect(hasPublishedClaudeAccount(new Map())).toBeUndefined();
	});
});

describe("resolveSessionClaudeAccount", () => {
	it("uses the live provider when the session is on Claude", () => {
		agentDirWithClaudeEnabled();
		const { ctx } = ctxWith({ provider: "anthropic-2", models: [{ provider: "anthropic", id: "claude-opus-5" }, { provider: "anthropic-2", id: "claude-opus-5" }] });
		expect(resolveSessionClaudeAccount(ctx, () => "company")).toEqual({ providerId: "anthropic-2", label: "company", active: true });
	});

	it("falls back to the first enabled Claude account on a non-Claude model", () => {
		agentDirWithClaudeEnabled();
		const { ctx } = ctxWith({ provider: "openai-codex", models: [{ provider: "anthropic", id: "claude-opus-5" }] });
		expect(resolveSessionClaudeAccount(ctx, () => "personal")).toEqual({ providerId: "anthropic", label: "default", active: false });
	});
});

describe("publishClaudeAccountStatus", () => {
	it("repaints a renamed label without waiting for an agent turn", () => {
		agentDirWithClaudeEnabled();
		let label = "company";
		const { ctx, statuses } = ctxWith({ provider: "anthropic-2", models: [{ provider: "anthropic-2", id: "claude-opus-5" }] });
		publishClaudeAccountStatus(ctx, { subscriptionLabel: () => label });
		expect(statuses.get(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY)).toBe("company");
		label = "personal";
		publishClaudeAccountStatus(ctx, { subscriptionLabel: () => label });
		expect(statuses.get(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY)).toBe("personal");
		expect(statuses.has(CLAUDE_ACCOUNT_STATUS_KEY)).toBe(false);
	});
});

describe("installClaudeAccountStatus", () => {
	it("publishes exactly one key per state", () => {
		agentDirWithClaudeEnabled();
		const harness = installHarness();
		const live = ctxWith({ provider: "anthropic-2", models: [{ provider: "anthropic-2", id: "claude-opus-5" }] });
		harness.fire("session_start", live.ctx);
		expect(live.statuses.get(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY)).toBe("company");
		expect(live.statuses.has(CLAUDE_ACCOUNT_STATUS_KEY)).toBe(false);

		const fallback = ctxWith({ provider: "deepseek", models: [{ provider: "anthropic", id: "claude-opus-5" }] });
		harness.fire("model_select", fallback.ctx);
		expect(fallback.statuses.get(CLAUDE_ACCOUNT_STATUS_KEY)).toBe("default");
		expect(fallback.statuses.has(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY)).toBe(false);
	});

	it("clears both keys when no Claude account is reachable", () => {
		agentDirWithClaudeEnabled();
		const harness = installHarness();
		const { ctx, statuses } = ctxWith({ provider: "openai-codex", models: [{ provider: "openai-codex", id: "gpt-5.6" }] });
		statuses.set(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY, "stale");
		harness.fire("session_start", ctx);
		expect(statuses.has(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY)).toBe(false);
		expect(statuses.has(CLAUDE_ACCOUNT_STATUS_KEY)).toBe(false);
	});

	it("refreshes at each turn boundary so a rename lands", () => {
		agentDirWithClaudeEnabled();
		const handlers = installHarness().handlers;
		expect([...handlers.keys()].sort()).toEqual(["agent_end", "model_select", "session_start"]);
	});

	it("ignores sessions without a UI", () => {
		agentDirWithClaudeEnabled();
		const harness = installHarness();
		const { ctx, statuses } = ctxWith({ provider: "anthropic-2", models: [{ provider: "anthropic-2", id: "claude-opus-5" }], hasUI: false });
		harness.fire("session_start", ctx);
		expect(statuses.size).toBe(0);
	});
});
