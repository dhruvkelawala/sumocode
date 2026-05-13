import { describe, expect, it, vi } from "vitest";
import { installQuestionTool, normalizeQuestionOptions, withCathedralForeground } from "./question-tool.js";

const ANSI_PATTERN = /\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

describe("normalizeQuestionOptions", () => {
	it("normalizes string and object options", () => {
		expect(normalizeQuestionOptions([
			"Keep it high-level",
			{ label: "Mention losses", description: "show real-money context" },
			"  ",
		])).toEqual([
			{ label: "Keep it high-level", value: "Keep it high-level" },
			{ label: "Mention losses — show real-money context", value: "Mention losses" },
		]);
	});

	it("returns empty list when options are omitted", () => {
		expect(normalizeQuestionOptions(undefined)).toEqual([]);
	});
});

describe("question tool options", () => {
	function themeStub() {
		return {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
	}

	it("renders provided options as selectable Divine Query choices", async () => {
		let tool: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { answer?: string; wasCustom?: boolean } }> } | undefined;
		const pi = {
			registerTool: vi.fn((definition) => { tool = definition; }),
		};
		let rendered = "";
		const ctx = {
			hasUI: true,
			ui: {
				custom: vi.fn((factory) => new Promise((resolve) => {
					const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, themeStub(), {}, resolve);
					rendered = component.render(80).join("\n");
					component.handleInput("enter");
				})),
			},
		};

		installQuestionTool(pi as never);
		const result = await tool!.execute("call-1", {
			question: "Preferred framing?",
			options: ["Keep it high-level", "Mention real-money bets/losses"],
		}, undefined, undefined, ctx);

		expect(stripAnsi(rendered)).toContain("A) Keep it high-level");
		expect(stripAnsi(rendered)).toContain("B) Mention real-money bets/losses");
		expect(stripAnsi(rendered)).toContain("C) Type something…");
		expect(result.details).toMatchObject({ answer: "Keep it high-level", wasCustom: false });
		expect(result.content[0]?.text).toBe("User answered: Keep it high-level");
	});

	it("returns the raw option label when an object option has helper text", async () => {
		let tool: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { answer?: string; wasCustom?: boolean } }> } | undefined;
		const pi = {
			registerTool: vi.fn((definition) => { tool = definition; }),
		};
		let rendered = "";
		const ctx = {
			hasUI: true,
			ui: {
				custom: vi.fn((factory) => new Promise((resolve) => {
					const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, themeStub(), {}, resolve);
					rendered = component.render(80).join("\n");
					component.handleInput("enter");
				})),
			},
		};

		installQuestionTool(pi as never);
		const result = await tool!.execute("call-1", {
			question: "Approve?",
			options: [{ label: "approve", description: "safe to proceed" }],
		}, undefined, undefined, ctx);

		const plain = stripAnsi(rendered);
		expect(plain).toContain("A) approve — safe to proceed");
		expect(result.details).toMatchObject({ answer: "approve", wasCustom: false });
		expect(result.content[0]?.text).toBe("User answered: approve");
	});

	it("treats a real option named like the free-text label as a selectable option", async () => {
		let tool: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { answer?: string; wasCustom?: boolean } }> } | undefined;
		const pi = {
			registerTool: vi.fn((definition) => { tool = definition; }),
		};
		let rendered = "";
		const ctx = {
			hasUI: true,
			ui: {
				custom: vi.fn((factory) => new Promise((resolve) => {
					const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, themeStub(), {}, resolve);
					rendered = component.render(80).join("\n");
					component.handleInput("enter");
				})),
			},
		};

		installQuestionTool(pi as never);
		const result = await tool!.execute("call-1", {
			question: "Pick one",
			options: ["Type something…"],
		}, undefined, undefined, ctx);

		const plain = stripAnsi(rendered);
		expect(plain).toContain("A) Type something…");
		expect(plain).toContain("B) Type something…");
		expect(result.details).toMatchObject({ answer: "Type something…", wasCustom: false });
	});

	it("auto-focuses free-text input when no options are provided", async () => {
		let tool: { execute: (...args: unknown[]) => Promise<{ details: { cancelled?: boolean } }> } | undefined;
		const pi = {
			registerTool: vi.fn((definition) => { tool = definition; }),
		};
		let rendered = "";
		const ctx = {
			hasUI: true,
			ui: {
				custom: vi.fn((factory) => new Promise((resolve) => {
					const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, themeStub(), {}, resolve);
					rendered = component.render(80).join("\n");
					resolve(null);
				})),
			},
		};

		installQuestionTool(pi as never);
		const result = await tool!.execute("call-1", { question: "What should I do?" }, undefined, undefined, ctx);

		const plain = stripAnsi(rendered);
		expect(plain).toContain("Your answer:");
		expect(plain).not.toContain("A) Type something…");
		expect(result.details).toMatchObject({ cancelled: true });
	});

	it("keeps free-text-only questions editable after an empty submit", async () => {
		let tool: { execute: (...args: unknown[]) => Promise<{ details: { cancelled?: boolean } }> } | undefined;
		const pi = {
			registerTool: vi.fn((definition) => { tool = definition; }),
		};
		let renderedAfterEmptySubmit = "";
		const ctx = {
			hasUI: true,
			ui: {
				custom: vi.fn((factory) => new Promise((resolve) => {
					const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, themeStub(), {}, resolve);
					component.handleInput("enter");
					renderedAfterEmptySubmit = component.render(80).join("\n");
					component.handleInput("\u001b");
				})),
			},
		};

		installQuestionTool(pi as never);
		const result = await tool!.execute("call-1", { question: "What should I do?" }, undefined, undefined, ctx);

		const plain = stripAnsi(renderedAfterEmptySubmit);
		expect(plain).toContain("Your answer:");
		expect(plain).not.toContain("A) Type something…");
		expect(result.details).toMatchObject({ cancelled: true });
	});
});

describe("withCathedralForeground", () => {
	it("re-applies Cathedral foreground after Pi default-fg reset (\\x1b[39m)", () => {
		const line = withCathedralForeground("[32mgreen from Pi[39m trailing");

		// Cathedral fg = 245;230;200
		expect(line.startsWith("[38;2;245;230;200m")).toBe(true);
		// After Pi's `[39m` default-fg reset, re-apply Cathedral fg so
		// trailing content stays inside the palette
		expect(line).toContain("[39m[38;2;245;230;200m");
		// Visible text is unchanged
		expect(stripAnsi(line)).toBe("green from Pi trailing");
	});

	it("re-applies Cathedral foreground after a full reset (\\x1b[0m)", () => {
		const line = withCathedralForeground("[0m[32mgreen[0m plain");

		expect(line).toContain("[0m[38;2;245;230;200m");
		expect(stripAnsi(line)).toBe("green plain");
	});

	it("does not change visible width", () => {
		const input = "     hello world cursor here";
		const wrapped = withCathedralForeground(input);
		expect(stripAnsi(wrapped)).toBe(input);
	});
});
