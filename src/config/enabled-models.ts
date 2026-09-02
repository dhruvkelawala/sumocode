import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BASE_PROVIDER, isClaudeAccountProvider } from "./claude-providers.js";

/** Any model-like record: Pi's `Model`, the host's option rows, or a test fixture. */
interface EnabledModelCandidate {
	readonly provider: string;
	readonly id: string;
}

const THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} satisfies Record<ModelThinkingLevel, true>;

function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

type JsonEntry = string | number | boolean | null | JsonEntry[] | { [key: string]: JsonEntry };

function isString(entry: JsonEntry | undefined): entry is string {
	return typeof entry === "string";
}

function isStringArray(value: JsonEntry | undefined): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isString);
}

export function readEnabledModelPatterns(env: NodeJS.ProcessEnv = process.env): string[] {
	try {
		// SAFETY: JSON.parse of our own settings.json; the only field consumed is
		// enabledModels and its shape is validated by isStringArray before use.
		const settings = JSON.parse(readFileSync(join(resolvePiAgentDir(env), "settings.json"), "utf8")) as { enabledModels?: JsonEntry };
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

function modelKey(model: EnabledModelCandidate): string {
	return `${model.provider}/${model.id}`.toLowerCase();
}

/**
 * Extra Claude accounts (`anthropic-N`) clone the base provider's model list,
 * so a base-provider pattern such as `anthropic/claude-opus-5` should enable
 * that model on every account without the user hand-listing each one. This
 * is the key such a pattern matches; explicit `anthropic-N/...` patterns keep
 * matching only their own account through `modelKey`.
 */
function baseProviderKey(model: EnabledModelCandidate): string | undefined {
	return isClaudeAccountProvider(model.provider) ? `${CLAUDE_BASE_PROVIDER}/${model.id}`.toLowerCase() : undefined;
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


function findExactModels<T extends EnabledModelCandidate>(pattern: string, models: readonly T[]): T[] {
	const normalized = pattern.trim().toLowerCase();
	if (!normalized) return [];
	const canonicalMatches = models.filter((model) => modelKey(model) === normalized);
	if (canonicalMatches.length > 1) return [];
	const slashIndex = normalized.indexOf("/");
	if (slashIndex !== -1) {
		return [...canonicalMatches, ...models.filter((model) => baseProviderKey(model) === normalized)];
	}
	// A bare id is ambiguous across unrelated providers, but the base
	// anthropic provider and its account clones are one logical model.
	const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
	const logicalKeys = new Set(idMatches.map((model) => baseProviderKey(model) ?? modelKey(model)));
	return logicalKeys.size === 1 ? idMatches : [];
}

function appendIfNew<T extends EnabledModelCandidate>(result: T[], seen: Set<string>, model: T): void {
	const key = modelKey(model);
	if (seen.has(key)) return;
	seen.add(key);
	result.push(model);
}

export function filterToEnabled<T extends EnabledModelCandidate>(models: readonly T[], patterns: readonly string[]): T[] {
	if (patterns.length === 0) return [...models];
	const result: T[] = [];
	const seen = new Set<string>();
	for (const rawPattern of patterns) {
		const pattern = stripThinkingSuffix(rawPattern.trim());
		if (!pattern) continue;
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			const regex = globToRegExp(pattern);
			for (const model of models) {
				const baseKey = baseProviderKey(model);
				if (regex.test(modelKey(model)) || regex.test(model.id) || (baseKey !== undefined && regex.test(baseKey))) {
					appendIfNew(result, seen, model);
				}
			}
			continue;
		}
		for (const model of findExactModels(pattern, models)) appendIfNew(result, seen, model);
	}
	return result;
}
