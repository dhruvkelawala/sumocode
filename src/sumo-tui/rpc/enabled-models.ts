import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcModelOption } from "./controls.js";

const THINKING_LEVELS: Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
};

function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");
}

export function readEnabledModelPatterns(env: NodeJS.ProcessEnv = process.env): string[] {
	try {
		const settings = JSON.parse(readFileSync(join(resolvePiAgentDir(env), "settings.json"), "utf8")) as { enabledModels?: unknown };
		return isStringArray(settings.enabledModels) ? settings.enabledModels : [];
	} catch {
		return [];
	}
}

function stripThinkingSuffix(pattern: string): string {
	const colonIndex = pattern.lastIndexOf(":");
	if (colonIndex === -1) return pattern;
	const suffix = pattern.slice(colonIndex + 1).toLowerCase();
	return Object.hasOwn(THINKING_LEVELS, suffix) ? pattern.slice(0, colonIndex) : pattern;
}

function modelKey(model: Pick<RpcModelOption, "provider" | "id">): string {
	return `${model.provider}/${model.id}`.toLowerCase();
}

function escapeRegexChar(char: string): string {
	return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i];
		if (char === "*") {
			source += ".*";
			continue;
		}
		if (char === "?") {
			source += ".";
			continue;
		}
		if (char === "[") {
			const closeIndex = pattern.indexOf("]", i + 1);
			if (closeIndex === -1) {
				source += "\\[";
				continue;
			}
			const content = pattern.slice(i + 1, closeIndex).replace(/\\/g, "\\\\");
			source += `[${content}]`;
			i = closeIndex;
			continue;
		}
		source += escapeRegexChar(char);
	}
	return new RegExp(`${source}$`, "i");
}


function findExactModel(pattern: string, models: readonly RpcModelOption[]): RpcModelOption | undefined {
	const normalized = pattern.trim().toLowerCase();
	if (!normalized) return undefined;
	const canonicalMatches = models.filter((model) => modelKey(model) === normalized);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;
	const slashIndex = normalized.indexOf("/");
	if (slashIndex !== -1) return undefined;
	const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function appendIfNew(result: RpcModelOption[], seen: Set<string>, model: RpcModelOption): void {
	const key = modelKey(model);
	if (seen.has(key)) return;
	seen.add(key);
	result.push(model);
}

export function filterToEnabled(models: readonly RpcModelOption[], patterns: readonly string[]): RpcModelOption[] {
	if (patterns.length === 0) return [...models];
	const result: RpcModelOption[] = [];
	const seen = new Set<string>();
	for (const rawPattern of patterns) {
		const pattern = stripThinkingSuffix(rawPattern.trim());
		if (!pattern) continue;
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			const regex = globToRegExp(pattern);
			for (const model of models) {
				if (regex.test(modelKey(model)) || regex.test(model.id)) appendIfNew(result, seen, model);
			}
			continue;
		}
		const model = findExactModel(pattern, models);
		if (model) appendIfNew(result, seen, model);
	}
	return result;
}
