import type * as PiTui from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FOCUSED_MARK, UNFOCUSED_MARK } from "../../cathedral/scriptorium-chrome.js";
import { InlineSelectorComponent, InlineSelectorHost } from "./inline-selector.js";

const fuzzyFilterCalls = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof PiTui>();
	return {
		...actual,
		fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string): T[] => {
			fuzzyFilterCalls.queries.push(query);
			return actual.fuzzyFilter(items, query, getText);
		},
	};
});

// pi-tui's `SelectList.handleInput` matches raw terminal byte sequences via
// its own `getKeybindings()` (see select-list.js), not the symbolic `Key.*`
// identifiers `ModalManager.handleInput` accepts loosely -- these are the
// actual legacy VT sequences (`keys.js`'s `LEGACY_KEY_SEQUENCES`/enter/escape
// cases) a real terminal would send.
const ARROW_DOWN = "[B";
const ENTER = "\r";
const ESCAPE = "";
const BACKSPACE = "\x7f";

class FakeEditor {
	public text = "";
	public readonly inputs: string[] = [];
	public splashProvider: (() => boolean) | undefined;

	public invalidate(): void {}

	public handleInput(data: string): void {
		this.inputs.push(data);
	}

	public render(width: number): string[] {
		return [`editor:${width}`];
	}

	public getText(): string {
		return this.text;
	}

	public setText(text: string): void {
		this.text = text;
	}

	public paste(text: string): void {
		this.text += text;
	}

	public setSplashProvider(provider: () => boolean): void {
		this.splashProvider = provider;
	}
}

describe("InlineSelectorComponent", () => {
	it("renders a Cathedral-styled title heading above the list rows", () => {
		const component = new InlineSelectorComponent("Choose model", ["a", "b"], () => undefined);
		const rows = component.render(40);
		const stripped = rows.join("\n").replace(/\[[0-9;]*m/g, "");
		expect(stripped).toContain("CHOOSE MODEL");
		expect(stripped).toContain("a");
		expect(stripped).toContain("b");
	});

	it("resolves with the selected option's exact string on Enter", () => {
		const done = vi.fn();
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], done);
		component.handleInput(ARROW_DOWN);
		component.handleInput(ENTER);
		expect(done).toHaveBeenCalledWith("beta");
	});

	it("resolves with undefined on Escape (cancel)", () => {
		const done = vi.fn();
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], done);
		component.handleInput(ESCAPE);
		expect(done).toHaveBeenCalledWith(undefined);
	});
});

describe("InlineSelectorComponent Cathedral styling (plan 037)", () => {
	it("P0: every row carries the panel background SGR, not just the title", () => {
		const component = new InlineSelectorComponent("Choose model", ["a", "b"], () => undefined);
		const rows = component.render(40);
		expect(rows.length).toBeGreaterThan(3);
		for (const row of rows) {
			expect(row).toMatch(/\x1b\[48;2;\d+;\d+;\d+m/);
		}
	});

	it("P0: the focused row uses the Cathedral glyph, not pi-tui's stock arrow", () => {
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], () => undefined);
		const rows = component.render(40).join("\n");
		expect(rows).toContain(FOCUSED_MARK);
		expect(rows).not.toContain("→ "); // "-> " -- SelectList.renderItem's old hard-coded prefix
	});

	it("P0: unfocused rows carry the dim unfocused marker and a dim SGR, not raw text", () => {
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta", "gamma"], () => undefined);
		const rows = component.render(40);
		const unfocusedRows = rows.filter((row) => row.includes("beta") || row.includes("gamma"));
		expect(unfocusedRows.length).toBe(2);
		for (const row of unfocusedRows) {
			expect(row).toContain(UNFOCUSED_MARK);
			// foregroundDim SGR precedes the label text on every unfocused row.
			expect(row).toMatch(/\x1b\[38;2;\d+;\d+;\d+m[^\x1b]*(beta|gamma)/);
		}
	});

	it("P1: the header is a centered, accent-colored title with the ornamental glyph convention and a rule divider beneath", () => {
		const component = new InlineSelectorComponent("choose model", ["a"], () => undefined);
		const rows = component.render(60);
		const titleRow = rows.find((row) => row.includes("CHOOSE MODEL"));
		expect(titleRow).toBeDefined();
		expect(titleRow).toContain("✦"); // "✦" ornamental glyph flanking the title
		const ruleRow = rows.find((row) => row.replace(/\x1b\[[0-9;]*m/g, "").includes("─"));
		expect(ruleRow).toBeDefined();
	});

	it("P1: a footer hint row (↑↓ choose / ⏎ select / ⎋ cancel) is appended after the list", () => {
		const component = new InlineSelectorComponent("Pick", ["a", "b"], () => undefined);
		const rows = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(rows).toContain("↑↓ choose");
		expect(rows).toContain("⏎ select");
		expect(rows).toContain("⎋ cancel");
	});

	it("P1: a description renders right-aligned in a second column", () => {
		const component = new InlineSelectorComponent(
			"Set thinking level",
			[
				{ value: "off", label: "off", description: "no reasoning" },
				{ value: "xhigh", label: "xhigh", description: "max reasoning" },
			],
			() => undefined,
		);
		const rows = component.render(70).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(rows).toContain("off");
		expect(rows).toContain("no reasoning");
		const offRow = rows.split("\n").find((row) => row.includes("off"));
		expect(offRow?.indexOf("no reasoning")).toBeGreaterThan(offRow!.indexOf("off") + 2);
	});

	it("P2: the option matching live state gets a current-selection marker independent of cursor position", () => {
		const component = new InlineSelectorComponent(
			"Choose model",
			[
				{ value: "anthropic/opus", label: "anthropic/opus" },
				{ value: "openai/gpt-5", label: "openai/gpt-5", isCurrent: true },
			],
			() => undefined,
		);
		// Cursor starts on row 0 (anthropic/opus), but the *current* marker
		// belongs to row 1 (openai/gpt-5) regardless of cursor position.
		const rows = component.render(60);
		const currentRow = rows.find((row) => row.includes("openai/gpt-5"));
		const otherRow = rows.find((row) => row.includes("anthropic/opus"));
		expect(currentRow).toContain("●"); // "●" current-value dot
		expect(otherRow).not.toContain("●");
	});

	it("P2: the scroll-overflow indicator picks up the panel background and an explicit dim foreground", () => {
		const options = Array.from({ length: 10 }, (_, index) => `option-${index}`);
		const component = new InlineSelectorComponent("Pick", options, () => undefined, 3);
		const rows = component.render(40);
		const scrollRow = rows.find((row) => row.includes("/10)"));
		expect(scrollRow).toBeDefined();
		// Panel background persists onto the scroll-indicator row...
		expect(scrollRow).toMatch(/\x1b\[48;2;\d+;\d+;\d+m/);
		// ...and the indicator text itself is explicitly dim-colored, not
		// pi-tui's plain unstyled "(N/M)".
		expect(scrollRow).toMatch(/\x1b\[38;2;\d+;\d+;\d+m\s*\(\d+\/10\)/);
	});
});

/**
 * A synthetic long fixture standing in for the real /model list this plan
 * is fixing (531 entries, unnavigable by arrow-key scrolling alone). Built
 * from real-shaped provider/model-id pairs, including deliberately
 * hyphenated/slashed IDs (e.g. "bytedance-seed/seed-1.6") to exercise the
 * fuzzyFilter-vs-substring gap the report calls out.
 */
function buildLongModelFixture(): string[] {
	const providers = [
		"openai",
		"anthropic",
		"openrouter",
		"bytedance-seed",
		"google",
		"mistral",
		"meta-llama",
		"cohere",
		"together",
		"fireworks",
	];
	const modelNames = [
		"gpt-5",
		"gpt-5-mini",
		"claude-opus-4-7",
		"claude-sonnet-5",
		"seed-1.6",
		"seed-1.6-flash",
		"gemini-3-pro",
		"mixtral-8x22b",
		"llama-4-maverick",
		"command-r-plus",
		"qwen3-max",
		"deepseek-v4",
	];
	const items: string[] = [];
	for (const provider of providers) {
		for (const modelName of modelNames) {
			items.push(`${provider}/${modelName}`);
		}
	}
	let index = 0;
	while (items.length < 540) {
		items.push(`filler-provider/filler-model-${index++}`);
	}
	return items;
}

describe("InlineSelectorComponent search-as-you-type (plan 038)", () => {
	it("computes filtered rows once for a printable keypress shared by input handling and render", () => {
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], () => undefined);
		component.render(60);
		fuzzyFilterCalls.queries.length = 0;

		component.handleInput("a");
		const rows = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

		expect(rows).toContain("alpha");
		expect(fuzzyFilterCalls.queries).toEqual(["a"]);
	});

	it("reuses the cached filtered rows for navigation keys when the query is unchanged", () => {
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta", "gamma"], () => undefined);
		component.render(60);
		fuzzyFilterCalls.queries.length = 0;

		component.handleInput(ARROW_DOWN);
		const rows = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

		expect(rows).toContain("beta");
		expect(fuzzyFilterCalls.queries).toEqual([]);
	});

	it("narrows a 540-item fixture to matching rows as a query is typed, and keeps the scroll window in-bounds over the filtered set", () => {
		const items = buildLongModelFixture();
		expect(items.length).toBeGreaterThan(500);

		const component = new InlineSelectorComponent("Choose model", items, () => undefined);

		// Type "seed16" one character at a time -- out of order relative to the
		// literal "seed-1.6" spelling (no hyphen, no dot) -- the exact case
		// plain substring matching fails on (see report).
		for (const char of "seed16") component.handleInput(char);

		const rows = component.render(80);
		const stripped = rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

		// The typed query itself renders in the search row.
		expect(stripped).toContain("seed16");
		// The filtered list narrows to seed-1.6 variants, not the full 540.
		expect(stripped).toContain("seed-1.6");
		expect(stripped).not.toContain("gpt-5");
		expect(stripped).not.toContain("filler-provider");

		// Scroll-window math must be computed over the FILTERED set: "seed-1.6"
		// matches 20 rows across the 10 synthetic providers (more than
		// DEFAULT_MAX_VISIBLE, so a scroll indicator does render), and its
		// total must read 20 -- if the window were still being computed
		// against the original 540-item fixture this would read "(n/540)".
		const scrollRow = rows.find((row) => /\(\d+\/\d+\)/.test(row.replace(/\x1b\[[0-9;]*m/g, "")));
		expect(scrollRow).toBeDefined();
		const stripedScrollRow = scrollRow!.replace(/\x1b\[[0-9;]*m/g, "");
		const match = stripedScrollRow.match(/\((\d+)\/(\d+)\)/);
		expect(match).not.toBeNull();
		const [, position, total] = match!;
		expect(Number(total)).toBe(20);
		expect(Number(position)).toBeGreaterThanOrEqual(1);
		expect(Number(position)).toBeLessThanOrEqual(20);
	});

	it("keeps the scroll window in-bounds when a query still matches more items than fit on screen", () => {
		const items = buildLongModelFixture();
		const component = new InlineSelectorComponent("Choose model", items, () => undefined, 5);

		// "e" alone matches far more than 5 items across the 540-item fixture.
		component.handleInput("e");
		// Push the cursor down repeatedly to move the scroll window away from index 0.
		for (let i = 0; i < 12; i++) component.handleInput("[B");

		const rows = component.render(80);
		const stripped = rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		const scrollMatch = stripped.match(/\((\d+)\/(\d+)\)/);
		expect(scrollMatch).not.toBeNull();
		const [, position, total] = scrollMatch!;
		// The total in the scroll indicator must reflect the FILTERED count,
		// not the original 540-item fixture.
		expect(Number(total)).toBeLessThan(540);
		expect(Number(position)).toBeGreaterThanOrEqual(1);
		expect(Number(position)).toBeLessThanOrEqual(Number(total));
	});

	it("resets selection to index 0 whenever the query changes", () => {
		const done = vi.fn();
		const items = buildLongModelFixture();
		const component = new InlineSelectorComponent("Choose model", items, done);

		component.handleInput("[B");
		component.handleInput("[B");
		component.handleInput("[B"); // selectedIndex now 3 in the unfiltered list

		component.handleInput("q"); // narrows to "qwen3-max" rows; must reset to index 0
		component.handleInput("\r"); // confirm
		expect(done).toHaveBeenCalledWith(expect.stringContaining("qwen3-max"));
	});

	it("backspace narrows the query back out and restores previously-hidden rows", () => {
		const items = ["openai/gpt-5", "anthropic/claude-opus-4-7"];
		const component = new InlineSelectorComponent("Choose model", items, () => undefined);

		component.handleInput("x"); // matches neither -- filtered list becomes empty
		let rows = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(rows).toContain("no matches");

		component.handleInput("\x7f"); // backspace clears the query
		rows = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(rows).toContain("openai/gpt-5");
		expect(rows).toContain("anthropic/claude-opus-4-7");
		expect(rows).not.toContain("no matches");
	});

	it("shows a distinct 'no matches' row (not the empty-list placeholder) when a query matches nothing", () => {
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], () => undefined);
		component.handleInput("z");
		const rows = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(rows).toContain("no matches");
		expect(rows).not.toContain("alpha");
		expect(rows).not.toContain("beta");
	});

	it("renders a dim placeholder in the search row when the query is empty, and the typed query once non-empty", () => {
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], () => undefined);
		const before = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(before).toContain("type to search");

		component.handleInput("a");
		const after = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(after).not.toContain("type to search");
		const searchRow = component.render(60).find((row) => row.includes("❯"));
		expect(searchRow?.replace(/\x1b\[[0-9;]*m/g, "")).toContain("a");
	});

	it("still marks the current-value item with the current marker when the list is filtered", () => {
		const component = new InlineSelectorComponent(
			"Choose model",
			[
				{ value: "openai/gpt-5", label: "openai/gpt-5" },
				{ value: "anthropic/claude-opus-4-7", label: "anthropic/claude-opus-4-7", isCurrent: true },
			],
			() => undefined,
		);
		for (const char of "claude") component.handleInput(char);
		const rows = component.render(70);
		const currentRow = rows.find((row) => row.includes("anthropic/claude-opus-4-7"));
		expect(currentRow).toContain("●");
		expect(rows.some((row) => row.includes("openai/gpt-5"))).toBe(false);
	});
});

describe("InlineSelectorHost", () => {
	it("passes through render/handleInput to the wrapped editor when no selector is active", () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		expect(host.getActiveKind()).toBeUndefined();
		expect(host.render(80)).toEqual(["editor:80"]);

		host.handleInput("x");
		expect(editor.inputs).toEqual(["x"]);
	});

	it("occupies the editor slot while a selector is open: render/handleInput route to the selector, not the editor", async () => {
		const editor = new FakeEditor();
		const onChange = vi.fn();
		const host = new InlineSelectorHost(editor, onChange);

		const resultPromise = host.select("Choose model", ["openai/gpt-5", "anthropic/opus"]);
		expect(host.getActiveKind()).toBe("select");
		expect(host.isActive()).toBe(true);

		const rendered = host.render(80).join("\n");
		const stripped = rendered.replace(/\[[0-9;]*m/g, "");
		expect(stripped).toContain("CHOOSE MODEL");
		expect(stripped).toContain("openai/gpt-5");
		expect(rendered).not.toContain("editor:80");

		// "x" is now a search keystroke (plan 038): it narrows the filtered
		// list rather than falling through anywhere, so the probe here checks
		// only that it never reaches the wrapped editor -- see the dedicated
		// "search-as-you-type" describe block below for filtering behavior.
		host.handleInput("x");
		expect(editor.inputs).toEqual([]); // routed to the selector, not the editor

		// Backspace clears the search keystroke above so Enter resolves against
		// the original (unfiltered) list.
		host.handleInput(BACKSPACE);
		host.handleInput(ENTER);
		await expect(resultPromise).resolves.toBe("openai/gpt-5");

		// Selector closed: editor slot restored.
		expect(host.getActiveKind()).toBeUndefined();
		expect(host.render(80)).toEqual(["editor:80"]);
	});

	it("Esc closes the selector and restores the editor with an undefined result", async () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		const resultPromise = host.select("Pick", ["a", "b"]);
		host.handleInput(ESCAPE);

		await expect(resultPromise).resolves.toBeUndefined();
		expect(host.getActiveKind()).toBeUndefined();
		expect(host.render(80)).toEqual(["editor:80"]);
	});

	it("close() dismisses the active selector externally (e.g. interrupt-tier Ctrl-C) with an undefined result", async () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		const resultPromise = host.select("Pick", ["a", "b"]);
		host.close();

		await expect(resultPromise).resolves.toBeUndefined();
		expect(host.getActiveKind()).toBeUndefined();
	});

	it("queues a second select() while one is active; it activates only after the first resolves", async () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		const first = host.select("First", ["a", "b"]);
		const second = host.select("Second", ["c", "d"]);

		expect(host.render(80).join("\n").replace(/\[[0-9;]*m/g, "")).toContain("FIRST");
		host.handleInput(ENTER);
		await expect(first).resolves.toBe("a");

		expect(host.render(80).join("\n").replace(/\[[0-9;]*m/g, "")).toContain("SECOND");
		host.handleInput(ENTER);
		await expect(second).resolves.toBe("c");

		expect(host.getActiveKind()).toBeUndefined();
	});

	it("forwards getText/setText/paste/setSplashProvider to the wrapped editor regardless of selector state", () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		host.setText("hello");
		expect(host.getText()).toBe("hello");
		host.paste(" world");
		expect(editor.text).toBe("hello world");

		const provider = () => true;
		host.setSplashProvider(provider);
		expect(editor.splashProvider).toBe(provider);

		void host.select("Pick", ["a"]);
		host.setText("still works while selector open");
		expect(editor.getText()).toBe("still works while selector open");
	});

	it("calls onChange when a selector opens, on input, and on close", async () => {
		const editor = new FakeEditor();
		const onChange = vi.fn();
		const host = new InlineSelectorHost(editor, onChange);

		const resultPromise = host.select("Pick", ["a", "b"]);
		expect(onChange).toHaveBeenCalled();
		onChange.mockClear();

		host.handleInput(ARROW_DOWN);
		expect(onChange).toHaveBeenCalled();
		onChange.mockClear();

		host.handleInput(ENTER);
		await resultPromise;
		expect(onChange).toHaveBeenCalled();
	});
});
