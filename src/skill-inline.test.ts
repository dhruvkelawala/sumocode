import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { type ReadSkillBody, expandInlineSkillTokens, installSkillInlineExpansion } from "./skill-inline.js";

const makeSkill = (overrides: Partial<Skill> = {}): Skill => ({
	name: "tdd",
	description: "test-driven development",
	filePath: "/skills/tdd/SKILL.md",
	baseDir: "/skills/tdd",
	sourceInfo: { path: "/skills/tdd/SKILL.md", source: "local", scope: "user", origin: "top-level" },
	disableModelInvocation: false,
	...overrides,
});

const readBody: ReadSkillBody = (skill) => `body of ${skill.name}`;

describe("expandInlineSkillTokens", () => {
	it("leaves start-of-message tokens alone so Pi's own expansion handles them", () => {
		const result = expandInlineSkillTokens("/skill:tdd please", [makeSkill()], readBody);
		expect(result.text).toBe("/skill:tdd please");
		expect(result.expanded).toEqual([]);
	});

	it("expands a skill invoked mid-sentence in place", () => {
		const result = expandInlineSkillTokens("please use /skill:tdd to fix this", [makeSkill()], readBody);
		expect(result.expanded).toEqual(["tdd"]);
		expect(result.text).toBe(
			'please use <skill name="tdd" location="/skills/tdd/SKILL.md">\nReferences are relative to /skills/tdd.\n\nbody of tdd\n</skill> to fix this',
		);
	});

	it("expands multiple distinct inline invocations", () => {
		const skills = [makeSkill(), makeSkill({ name: "apr", filePath: "/skills/apr/SKILL.md", baseDir: "/skills/apr" })];
		const result = expandInlineSkillTokens("run /skill:tdd then /skill:apr", skills, readBody);
		expect(result.expanded).toEqual(["tdd", "apr"]);
		expect(result.text).toContain('name="tdd"');
		expect(result.text).toContain('name="apr"');
	});

	it("passes through unknown skill names untouched", () => {
		const result = expandInlineSkillTokens("use /skill:nope here", [makeSkill()], readBody);
		expect(result.text).toBe("use /skill:nope here");
		expect(result.expanded).toEqual([]);
	});

	it("does not treat path-like fragments as invocations", () => {
		const result = expandInlineSkillTokens("see docs/skill:tdd/readme", [makeSkill()], readBody);
		expect(result.text).toBe("see docs/skill:tdd/readme");
		expect(result.expanded).toEqual([]);
	});

	it("requires whitespace before the token (no partial-word matches)", () => {
		const result = expandInlineSkillTokens("prefix/skill:tdd suffix", [makeSkill()], readBody);
		expect(result.expanded).toEqual([]);
	});

	it("falls back to pass-through when the skill file cannot be read", () => {
		const failingRead: ReadSkillBody = () => {
			throw new Error("enoent");
		};
		const result = expandInlineSkillTokens("use /skill:tdd now", [makeSkill()], failingRead);
		expect(result.text).toBe("use /skill:tdd now");
		expect(result.expanded).toEqual([]);
	});
});

describe("installSkillInlineExpansion", () => {
	it("registers input and session_start handlers without loading skills eagerly", () => {
		const handlers = new Map<string, unknown>();
		const pi = { on: (event: string, handler: unknown) => handlers.set(event, handler) } as unknown as ExtensionAPI;
		installSkillInlineExpansion(pi);
		expect(handlers.has("input")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
	});
});
