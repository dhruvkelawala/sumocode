import * as fs from "node:fs";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	SettingsManager,
	type Skill,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

/**
 * Inline `/skill:name` expansion.
 *
 * Pi's `AgentSession._expandSkillCommand` only expands `/skill:name` when the
 * message *starts* with the token (`text.startsWith("/skill:")`). A skill
 * invoked mid-sentence ("please use /skill:tdd here") passes through
 * unexpanded. This module closes that gap with an extension `input` handler,
 * which Pi runs before its own skill/template expansion.
 *
 * Semantics mirror Pi's expansion: the selected token is hoisted into the
 * canonical `<skill name=... location=...>` envelope at the start of the
 * message, followed by the remaining user text. Pi's transcript parser only
 * collapses that exact envelope shape. An occurrence at index 0 is left alone
 * so Pi's own path handles it exactly as before (no double expansion). Unknown
 * skill names pass through untouched, matching Pi's behavior.
 */

const SKILL_TOKEN = /(^|(?<=\s))\/skill:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const ATTACHED_SKILL_SUFFIX = /^(?:[,.;:!?%‰°)\]}]|['’](?:s|t|re|ve|ll|d|m)\b)/iu;

export type InlineSkillExpansion = { text: string; expanded: string[] };

export type ReadSkillBody = (skill: Skill) => string;

const readSkillBodyFromDisk: ReadSkillBody = (skill) => stripFrontmatter(fs.readFileSync(skill.filePath, "utf-8")).trim();

export const expandInlineSkillTokens = (
	text: string,
	skills: readonly Skill[],
	readSkillBody: ReadSkillBody = readSkillBodyFromDisk,
): InlineSkillExpansion => {
	// Pi already owns a start-of-message invocation, including its arguments.
	if (text.startsWith("/skill:")) return { text, expanded: [] };
	const byName = new Map<string, Skill>();
	for (const skill of skills) byName.set(skill.name, skill);

	for (const match of text.matchAll(SKILL_TOKEN)) {
		const offset = match.index;
		if (offset === 0) continue;
		const name = match[2];
		const skill = name ? byName.get(name) : undefined;
		if (!skill) continue;
		let body = "";
		try {
			body = readSkillBody(skill).trim();
		} catch {
			continue;
		}
		const rawBefore = text.slice(0, offset);
		const rawAfter = text.slice(offset + match[0].length);
		const boundaryWhitespace = (rawBefore.match(/\s*$/)?.[0] ?? "") + (rawAfter.match(/^\s*/)?.[0] ?? "");
		const before = rawBefore.trimEnd();
		const after = rawAfter.trimStart();
		const separator = before.length > 0 && after.length > 0
			? boundaryWhitespace.includes("\n")
				? "\n"
				: ATTACHED_SKILL_SUFFIX.test(after)
					? ""
					: " "
			: "";
		const userMessage = `${before}${separator}${after}`.trim();
		const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return { text: userMessage ? `${skillBlock}\n\n${userMessage}` : skillBlock, expanded: [name] };
	}

	return { text, expanded: [] };
};

export type SkillInlineExpansionOptions = {
	readonly cwd?: string;
	readonly discoverSkills?: (cwd?: string) => Promise<Skill[]>;
	readonly readSkillBody?: ReadSkillBody;
};

/**
 * Discover the same package, `.pi`, and ancestor `.agents/skills` resources as
 * Pi's active loader. `loadSkills()` alone misses package-manager additions
 * such as this repo's `.agents/skills/herdr`.
 */
export async function discoverSkills(cwd?: string): Promise<Skill[]> {
	const resolvedCwd = cwd ?? process.cwd();
	const settingsManager = SettingsManager.create(resolvedCwd);
	const loader = new DefaultResourceLoader({
		cwd: resolvedCwd,
		agentDir: getAgentDir(),
		settingsManager,
		// Resource discovery needs package/.agents paths, not another recursive
		// activation of SumoCode or unrelated extensions.
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	return loader.getSkills().skills;
}

export function installSkillInlineExpansion(pi: ExtensionAPI, options: SkillInlineExpansionOptions = {}): void {
	let cache: Promise<Skill[]> | undefined;
	const loadSkillsOnce = (): Promise<Skill[]> => {
		cache ??= (options.discoverSkills ?? discoverSkills)(options.cwd);
		return cache;
	};
	// Skills can change across /reload; drop the cache on session lifecycle.
	pi.on("session_start", () => {
		cache = undefined;
	});
	pi.on("input", async (event) => {
		if (!event.text.includes("/skill:")) return { action: "continue" };
		try {
			const { text, expanded } = expandInlineSkillTokens(
				event.text,
				await loadSkillsOnce(),
				options.readSkillBody ?? readSkillBodyFromDisk,
			);
			if (expanded.length === 0) return { action: "continue" };
			return { action: "transform", text };
		} catch {
			return { action: "continue" };
		}
	});
}
