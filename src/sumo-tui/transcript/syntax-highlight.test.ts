import { afterEach, describe, expect, it } from "vitest";
import { activeThemeApplicationRoles, resetThemeRegistryForTests } from "../../themes/index.js";
import { ensureLanguage, highlightLine, highlightLineFallback, onHighlighterReady, resetSyntaxHighlighterForTests } from "./syntax-highlight.js";

const roles = () => activeThemeApplicationRoles().code;

async function withGrammar(lang: string): Promise<void> {
	await ensureLanguage(lang, roles());
}

const SAMPLES: ReadonlyArray<{ readonly fence: string; readonly id: string; readonly line: string }> = [
	{ fence: "ts", id: "typescript", line: "\tconst total: Record<string, number> = compute(42, \"ok\"); // note" },
	{ fence: "bash", id: "shellscript", line: "for f in *.log; do grep -n 'warn' \"$f\"; done # scan" },
	{ fence: "json", id: "json", line: "  { \"name\": \"sumocode\", \"port\": 8080, \"ok\": true }" },
	{ fence: "diff", id: "diff", line: "-const before = 1;" },
];

describe("syntax highlighting", () => {
	afterEach(() => {
		resetSyntaxHighlighterForTests();
		resetThemeRegistryForTests();
	});

	it("covers every input character exactly, for every sample language", async () => {
		for (const sample of SAMPLES) {
			await withGrammar(sample.id);
			const spans = highlightLine(sample.line, sample.fence, roles());
			expect(spans.map((s) => s.text).join(""), `coverage for ${sample.fence}`).toBe(sample.line);
		}
	});

	it("covers every input character exactly before the grammar is ready", () => {
		for (const sample of SAMPLES) {
			const spans = highlightLine(sample.line, sample.fence, roles());
			expect(spans.map((s) => s.text).join(""), `fallback coverage for ${sample.fence}`).toBe(sample.line);
		}
	});

	it("emits only theme role hexes, never ANSI", async () => {
		await withGrammar("typescript");
		const spans = highlightLine(SAMPLES[0]!.line, "ts", roles());
		const palette = new Set(Object.values(roles()));
		for (const s of spans) {
			expect(s.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
			// oxlint-disable-next-line no-control-regex -- asserting the absence of ESC
			expect(s.text).not.toMatch(/\u001b/);
			expect(palette.has(s.color), `${s.color} is not a code role colour`).toBe(true);
		}
	});

	it("uses the fallback tokenizer before the grammar lands and Shiki after", async () => {
		const line = "const total: Record<string, number> = compute(42);";
		const before = highlightLine(line, "ts", roles());
		expect(before).toEqual(highlightLineFallback(line, "ts", roles()));
		// The fallback has no grammar, so a type reference stays foreground.
		expect(before.find((s) => s.text === "Record")?.color).toBe(roles().foreground);

		await withGrammar("typescript");
		const after = highlightLine(line, "ts", roles());
		expect(after).not.toEqual(before);
		// Shiki resolves `Record` as a type name, which rides the function role.
		expect(after.find((s) => s.text === "Record")?.color).toBe(roles().function);
	});

	it("notifies ready subscribers once a grammar lands", async () => {
		let calls = 0;
		const dispose = onHighlighterReady(() => { calls += 1; });
		await withGrammar("python");
		expect(calls).toBe(1);
		dispose();
		await withGrammar("json");
		expect(calls).toBe(1);
	});

	it("renders unknown languages as plain foreground without inventing keywords", () => {
		const line = "SELECT ⟨glyph⟩ if for 42 \"x\"";
		const spans = highlightLine(line, "brainfuck", roles());
		expect(spans).toEqual([{ text: line, color: roles().foreground }]);
	});

	it("re-registers the theme after a theme switch", async () => {
		await withGrammar("typescript");
		const cathedralKeyword = highlightLine("const x = 1;", "ts", roles()).find((s) => s.text === "const")?.color;
		const { setActiveTheme } = await import("../../themes/index.js");
		setActiveTheme("ultraviolet-core");
		const uvRoles = roles();
		const uvKeyword = highlightLine("const x = 1;", "ts", uvRoles).find((s) => s.text === "const")?.color;
		expect(uvKeyword).toBe(uvRoles.keyword);
		expect(uvKeyword).not.toBe(cathedralKeyword);
	});
});
