import { describe, expect, it, vi } from "vitest";
import { parseSkillBlock, type Skill } from "@earendil-works/pi-coding-agent";
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

	it("hoists a mid-sentence skill into Pi's collapsible envelope shape", () => {
		const result = expandInlineSkillTokens("please use /skill:tdd to fix this", [makeSkill()], readBody);
		expect(result.expanded).toEqual(["tdd"]);
		expect(result.text).toBe(
			'<skill name="tdd" location="/skills/tdd/SKILL.md">\nReferences are relative to /skills/tdd.\n\nbody of tdd\n</skill>\n\nplease use to fix this',
		);
		expect(parseSkillBlock(result.text)).toMatchObject({
			name: "tdd",
			location: "/skills/tdd/SKILL.md",
			userMessage: "please use to fix this",
		});
	});

	it("preserves a newline when removing a skill token on its own line", () => {
		const result = expandInlineSkillTokens("before\n/skill:tdd\nafter", [makeSkill()], readBody);
		expect(parseSkillBlock(result.text)?.userMessage).toBe("before\nafter");
	});

	it("preserves indentation after removing a standalone skill line", () => {
		const result = expandInlineSkillTokens("Please review:\n/skill:tdd\n    if (x) {", [makeSkill()], readBody);
		expect(parseSkillBlock(result.text)?.userMessage).toBe("Please review:\n    if (x) {");
	});

	it("preserves indentation at the beginning of the remaining prompt", () => {
		const result = expandInlineSkillTokens("    if (x) {}\nuse /skill:tdd", [makeSkill()], readBody);
		expect(result.text.endsWith("</skill>\n\n    if (x) {}\nuse")).toBe(true);
	});

	it("keeps trailing punctuation attached when removing an inline skill", () => {
		const comma = expandInlineSkillTokens("use /skill:tdd, please", [makeSkill()], readBody);
		const possessive = expandInlineSkillTokens("follow /skill:tdd's guidance", [makeSkill()], readBody);
		expect(parseSkillBlock(comma.text)?.userMessage).toBe("use, please");
		expect(parseSkillBlock(possessive.text)?.userMessage).toBe("follow's guidance");
	});

	it("expands one skill per prompt, matching Pi's command semantics", () => {
		const skills = [makeSkill(), makeSkill({ name: "apr", filePath: "/skills/apr/SKILL.md", baseDir: "/skills/apr" })];
		const result = expandInlineSkillTokens("run /skill:tdd then /skill:apr", skills, readBody);
		expect(result.expanded).toEqual(["tdd"]);
		expect(result.text).toContain('name="tdd"');
		expect(result.text).toContain("run then /skill:apr");
		expect(result.text).not.toContain('name="apr"');
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
	type PiHandler = (event: { text: string }) => Promise<{ action: string; text?: string }>;

	it("registers input and session_start handlers without loading skills eagerly", () => {
		const handlers = new Map<string, PiHandler>();
		// SAFETY: the on() double supplies the registrar surface installSkillInlineExpansion reads.
		const pi = { on: (event: string, handler: PiHandler) => handlers.set(event, handler) } as never;
		installSkillInlineExpansion(pi);
		expect(handlers.has("input")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
	});

	it("retries discovery after a transient rejection", async () => {
		const handlers = new Map<string, PiHandler>();
		// SAFETY: the on() double supplies the registrar surface installSkillInlineExpansion reads.
		const pi = { on: (event: string, handler: PiHandler) => handlers.set(event, handler) } as never;
		const discoverSkills = vi.fn()
			.mockRejectedValueOnce(new Error("temporary filesystem failure"))
			.mockResolvedValueOnce([makeSkill()]);
		installSkillInlineExpansion(pi, { discoverSkills, readSkillBody: readBody });
		const input = handlers.get("input")!;

		expect(await input({ text: "use /skill:tdd now" })).toEqual({ action: "continue" });
		expect(await input({ text: "use /skill:tdd now" })).toMatchObject({ action: "transform" });
		expect(discoverSkills).toHaveBeenCalledTimes(2);
	});

	it("uses resource-loader discovery so contributed skills can transform", async () => {
		const handlers = new Map<string, PiHandler>();
		// SAFETY: the on() double supplies the registrar surface installSkillInlineExpansion reads.
		const pi = { on: (event: string, handler: PiHandler) => handlers.set(event, handler) } as never;
		const herdr = makeSkill({ name: "herdr", filePath: "/project/.agents/skills/herdr/SKILL.md", baseDir: "/project/.agents/skills/herdr" });
		installSkillInlineExpansion(pi, { discoverSkills: async () => [herdr], readSkillBody: readBody });

		const result = await handlers.get("input")!({ text: "check this /skill:herdr" });
		expect(result).toEqual({
			action: "transform",
			text: '<skill name="herdr" location="/project/.agents/skills/herdr/SKILL.md">\nReferences are relative to /project/.agents/skills/herdr.\n\nbody of herdr\n</skill>\n\ncheck this',
		});
	});
});
