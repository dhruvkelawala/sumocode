import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filterToEnabled, readEnabledModelPatterns } from "./enabled-models.js";

interface RpcModelOption {
	readonly provider: string;
	readonly id: string;
	readonly label: string;
	readonly active: boolean;
}

function option(provider: string, id: string, active = false): RpcModelOption {
	return {
		provider,
		id,
		label: `${provider}/${id}`,
		active,
	};
}

const MODELS: RpcModelOption[] = [
	option("openai", "gpt-5"),
	option("anthropic", "claude-sonnet-4"),
	option("google", "gemini-3"),
	option("anthropic", "claude-opus-4", true),
	option("openrouter", "gpt-5"),
];

function withAgentDir<T>(body: (dir: string, env: NodeJS.ProcessEnv) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-enabled-models-"));
	try {
		return body(dir, { PI_CODING_AGENT_DIR: dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeSettings(dir: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), content);
}

describe("filterToEnabled with extra Claude accounts", () => {
	const ACCOUNT_MODELS: RpcModelOption[] = [
		option("anthropic", "claude-opus-4"),
		option("anthropic", "claude-sonnet-4"),
		option("anthropic-2", "claude-opus-4"),
		option("anthropic-2", "claude-sonnet-4"),
		option("anthropic-3", "claude-opus-4"),
		option("openai", "gpt-5"),
	];

	it("mirrors an exact base anthropic pattern onto every account provider", () => {
		expect(filterToEnabled(ACCOUNT_MODELS, ["anthropic/claude-opus-4"]).map((m) => m.label)).toEqual([
			"anthropic/claude-opus-4",
			"anthropic-2/claude-opus-4",
			"anthropic-3/claude-opus-4",
		]);
	});

	it("mirrors a base anthropic glob onto account providers", () => {
		expect(filterToEnabled(ACCOUNT_MODELS, ["anthropic/claude-sonnet-*"]).map((m) => m.label)).toEqual([
			"anthropic/claude-sonnet-4",
			"anthropic-2/claude-sonnet-4",
		]);
	});

	it("keeps explicit account patterns scoped to that account", () => {
		expect(filterToEnabled(ACCOUNT_MODELS, ["anthropic-2/claude-opus-4"]).map((m) => m.label)).toEqual(["anthropic-2/claude-opus-4"]);
	});

	it("does not duplicate a model named by both a base and an explicit account pattern", () => {
		expect(filterToEnabled(ACCOUNT_MODELS, ["anthropic-2/claude-opus-4", "anthropic/claude-opus-4"]).map((m) => m.label)).toEqual([
			"anthropic-2/claude-opus-4",
			"anthropic/claude-opus-4",
			"anthropic-3/claude-opus-4",
		]);
	});

	it("keeps a bare Claude model id resolvable across the base and account providers", () => {
		expect(filterToEnabled(ACCOUNT_MODELS, ["claude-opus-4"]).map((m) => m.label)).toEqual([
			"anthropic/claude-opus-4",
			"anthropic-2/claude-opus-4",
			"anthropic-3/claude-opus-4",
		]);
	});

	it("still treats a bare id shared by unrelated providers as ambiguous", () => {
		const models = [...ACCOUNT_MODELS, option("openrouter", "claude-opus-4")];
		expect(filterToEnabled(models, ["claude-opus-4"])).toEqual([]);
		expect(filterToEnabled(ACCOUNT_MODELS, ["gpt-5"]).map((m) => m.label)).toEqual(["openai/gpt-5"]);
	});
});

describe("filterToEnabled", () => {
	it("selects exact provider/id entries in enabledModels order", () => {
		expect(filterToEnabled(MODELS, ["google/gemini-3", "openai/gpt-5"])).toEqual([
			MODELS[2],
			MODELS[0],
		]);
	});

	it("accepts a bare id only when that id uniquely identifies one provider", () => {
		expect(filterToEnabled(MODELS, ["gemini-3", "gpt-5"])).toEqual([
			MODELS[2],
		]);
	});

	it("expands *, ?, and [...] globs against provider/id and bare id case-insensitively in available-list order", () => {
		expect(filterToEnabled(MODELS, ["ANTHROPIC/*", "GEMINI-?", "claude-[so]*"])).toEqual([
			MODELS[1],
			MODELS[3],
			MODELS[2],
		]);
	});

	it("strips valid thinking suffixes before matching", () => {
		expect(filterToEnabled(MODELS, ["anthropic/claude-opus-4:high"])).toEqual([
			MODELS[3],
		]);
	});

	it("skips unknown patterns and dedupes repeated provider/id matches", () => {
		expect(filterToEnabled(MODELS, [
			"missing/provider",
			"openai/gpt-5",
			"OPENAI/GPT-5",
			"anthropic/*",
			"anthropic/claude-opus-4",
		])).toEqual([
			MODELS[0],
			MODELS[1],
			MODELS[3],
		]);
	});

	it("returns the full available list when no enabled patterns are configured", () => {
		expect(filterToEnabled(MODELS, [])).toEqual(MODELS);
	});
});

describe("readEnabledModelPatterns", () => {
	it("reads a non-empty enabledModels array from the configured Pi agent settings file", () => {
		withAgentDir((dir, env) => {
			writeSettings(dir, JSON.stringify({ enabledModels: ["anthropic/*", "openai/gpt-5:high"] }));

			expect(readEnabledModelPatterns(env)).toEqual(["anthropic/*", "openai/gpt-5:high"]);
		});
	});

	it.each([
		["missing settings.json", undefined],
		["malformed settings.json", "{ not json"],
		["missing enabledModels", JSON.stringify({ other: ["openai/gpt-5"] })],
		["empty enabledModels", JSON.stringify({ enabledModels: [] })],
	])("returns [] without throwing for %s", (_name, content) => {
		withAgentDir((dir, env) => {
			if (content !== undefined) writeSettings(dir, content);

			expect(readEnabledModelPatterns(env)).toEqual([]);
		});
	});
});
