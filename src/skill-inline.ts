import * as fs from "node:fs";
import {
	type ExtensionAPI,
	getAgentDir,
	loadSkills,
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
 * Semantics mirror Pi's expansion: the token is replaced in place with a
 * `<skill name=... location=...>` block containing the frontmatter-stripped
 * body and the "References are relative to ..." header line. An occurrence at
 * index 0 is left alone so Pi's own path handles it exactly as before (no
 * double expansion). Unknown skill names pass through untouched, matching Pi's
 * "unknown skill → pass through" behavior.
 */

const SKILL_TOKEN = /(^|(?<=\s))\/skill:([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export type InlineSkillExpansion = { text: string; expanded: string[] };

export type ReadSkillBody = (skill: Skill) => string;

const readSkillBodyFromDisk: ReadSkillBody = (skill) => stripFrontmatter(fs.readFileSync(skill.filePath, "utf-8")).trim();

export const expandInlineSkillTokens = (
	text: string,
	skills: readonly Skill[],
	readSkillBody: ReadSkillBody = readSkillBodyFromDisk,
): InlineSkillExpansion => {
	const byName = new Map<string, Skill>();
	for (const skill of skills) byName.set(skill.name, skill);

	const expanded: string[] = [];
	const result = text.replace(SKILL_TOKEN, (match, prefix: string, name: string, offset: number) => {
		// Index 0 is Pi's own start-of-message expansion path; leave it intact.
		if (offset === 0) return match;
		const skill = byName.get(name);
		if (!skill) return match;
		let body = "";
		try {
			body = readSkillBody(skill).trim();
		} catch {
			return match;
		}
		expanded.push(name);
		return `${prefix}<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	});

	return { text: result, expanded };
};

type SkillDiscovery = { cwd?: string };

/** Loads skills using the same discovery surface as the native task tool. */
const discoverSkills = (cwd?: string): Skill[] => {
	const resolvedCwd = cwd ?? process.cwd();
	const settingsManager = SettingsManager.create(resolvedCwd);
	return loadSkills({
		cwd: resolvedCwd,
		agentDir: getAgentDir(),
		skillPaths: settingsManager.getSkillPaths(),
		includeDefaults: true,
	}).skills;
};

export function installSkillInlineExpansion(pi: ExtensionAPI, options: SkillDiscovery = {}): void {
	let cache: { cwd: string | undefined; skills: Skill[] } | undefined;
	const loadSkillsOnce = (): Skill[] => {
		if (!cache || cache.cwd !== options.cwd) cache = { cwd: options.cwd, skills: discoverSkills(options.cwd) };
		return cache.skills;
	};
	// Skills can change across /reload; drop the cache on session lifecycle.
	pi.on("session_start", () => {
		cache = undefined;
	});
	pi.on("input", (event) => {
		if (!event.text.includes("/skill:")) return { action: "continue" };
		const { text, expanded } = expandInlineSkillTokens(event.text, loadSkillsOnce());
		if (expanded.length === 0) return { action: "continue" };
		return { action: "transform", text };
	});
}
