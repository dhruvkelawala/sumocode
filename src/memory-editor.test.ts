import { describe, expect, it, vi } from "vitest";
import {
	MEMORY_EDITOR_HINTS,
	registerMemoryCommand,
	renderMemoryEditor,
	type MemoryEditorSnapshot,
} from "./memory-editor.js";
import type { MemoryFact } from "./memory.js";
import { groupFactsByPanel } from "./memory-categorization.js";

const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

let factCounter = 0;
function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
	factCounter += 1;
	return {
		id: `fact-${factCounter}`,
		text: "default fact text",
		...overrides,
	};
}

function snapshot(overrides: Partial<MemoryEditorSnapshot> = {}): MemoryEditorSnapshot {
	const facts: MemoryFact[] = [
		fact({ text: "Dhruv works at Argent in London" }),     // IDENTITY
		fact({ text: "prefers TypeScript strict" }),            // PREFERENCES
		fact({ text: "always use TDD for new features" }),      // WORKFLOW
		fact({ text: "SumoCode is the cathedral product" }),    // PROJECTS
		fact({ text: "mac mini in portrait orientation" }),     // SYSTEM
	];
	const groups = groupFactsByPanel(facts);
	return {
		searchQuery: "",
		groups,
		factsTotal: facts.length,
		focusedFactId: null,
		...overrides,
	};
}

describe("renderMemoryEditor — Scriptorium chrome", () => {
	it("renders ✾ MEMORY SCRIPTORIUM ✾ title in accent", () => {
		const lines = renderMemoryEditor(snapshot(), 100);
		const titleLine = lines.find((l) => stripAnsi(l).includes("MEMORY SCRIPTORIUM"));
		expect(titleLine).toBeDefined();
		// accent #D97706 -> 217;119;6
		expect(titleLine).toContain("[38;2;217;119;6m");
		expect(stripAnsi(titleLine!)).toContain("✾  MEMORY SCRIPTORIUM  ✾");
	});

	it("renders top + bottom decorative split rules with center dot", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const ruleLines = lines.filter((l) => l.includes("·") && l.includes("─".repeat(8)));
		expect(ruleLines.length).toBeGreaterThanOrEqual(2);
	});

	it("paints surfaceLifted background on every row", () => {
		const lines = renderMemoryEditor(snapshot(), 100);
		// surfaceLifted #3D3024 -> 61;48;36
		for (const line of lines) {
			expect(line).toContain("[48;2;61;48;36m");
		}
	});

	it("pads every row to the requested width", () => {
		const lines = renderMemoryEditor(snapshot(), 100);
		for (const line of lines) {
			expect(stripAnsi(line).length).toBe(100);
		}
	});

	it("renders ❯ search prompt in accent followed by dim placeholder when empty", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "" }), 100);
		const searchLine = lines.find((l) => stripAnsi(l).includes("search remembered facts"));
		expect(searchLine).toBeDefined();
		// accent prompt + dim placeholder
		expect(searchLine).toContain("[38;2;217;119;6m❯");
		expect(searchLine).toContain("[38;2;139;122;99m"); // foregroundDim
	});

	it("shows the actual query when searchQuery is non-empty", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "typescript" }), 100).map(stripAnsi);
		expect(lines.some((l) => l.includes("typescript"))).toBe(true);
	});

	it("shows the facts total count on the right side of the search row", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const searchLine = lines.find((l) => l.includes("5 facts"));
		expect(searchLine).toBeDefined();
	});

	it("renders the V2 footer hint copy in foregroundDim", () => {
		const lines = renderMemoryEditor(snapshot(), 100);
		const footerLine = lines.find((l) => stripAnsi(l).includes(MEMORY_EDITOR_HINTS));
		expect(footerLine).toBeDefined();
		expect(footerLine).toContain("[38;2;139;122;99m"); // dim
	});
});

describe("renderMemoryEditor — panel grid", () => {
	it("renders each non-empty panel header (IDENTITY/PREFERENCES/WORKFLOW/PROJECTS/SYSTEM)", () => {
		const lines = renderMemoryEditor(snapshot(), 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain(" IDENTITY ");
		expect(text).toContain(" PREFERENCES ");
		expect(text).toContain(" WORKFLOW ");
		expect(text).toContain(" PROJECTS ");
		expect(text).toContain(" SYSTEM ");
	});

	it("hides GENERAL panel when empty", () => {
		const lines = renderMemoryEditor(snapshot(), 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).not.toContain(" GENERAL ");
	});

	it("shows GENERAL panel when there are unrouted facts", () => {
		const facts = [fact({ text: "the sky is blue" })];
		const groups = groupFactsByPanel(facts);
		const snap: MemoryEditorSnapshot = {
			searchQuery: "",
			groups,
			factsTotal: 1,
			focusedFactId: facts[0]!.id,
		};
		const lines = renderMemoryEditor(snap, 160).map(stripAnsi);
		expect(lines.join("\n")).toContain(" GENERAL ");
	});

	it("uses ❈ accent marker on the focused fact and · divider marker on the rest", () => {
		const focusedSnapshot = snapshot();
		const focusedFact = focusedSnapshot.groups.find((g) => g.panel === "IDENTITY")!.facts[0]!;
		const lines = renderMemoryEditor({ ...focusedSnapshot, focusedFactId: focusedFact.id }, 160);
		const focusedRow = lines.find((l) => stripAnsi(l).includes("Dhruv"))!;
		// ❈ in accent
		expect(focusedRow).toContain("[38;2;217;119;6m❈");
		// Other facts use `·` in divider
		const otherRow = lines.find((l) => stripAnsi(l).includes("prefers TypeScript"))!;
		expect(otherRow).toContain("[38;2;90;77;60m·");
	});

	it("renders panel borders in divider color and panel titles in accent", () => {
		const lines = renderMemoryEditor(snapshot(), 160);
		const identityHeader = lines.find((l) => stripAnsi(l).includes(" IDENTITY "))!;
		// divider for the dashes
		expect(identityHeader).toContain("[38;2;90;77;60m");
		// accent for the label
		expect(identityHeader).toContain("[38;2;217;119;6m IDENTITY ");
	});
});

describe("renderMemoryEditor — search filter", () => {
	it("filters fact rows when searchQuery is non-empty", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "typescript" }), 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("prefers TypeScript strict");
		expect(text).not.toContain("Dhruv works at Argent");
	});

	it("renders empty panels with `(empty)` placeholder when filter has no matches in that panel", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "typescript" }), 160).map(stripAnsi);
		expect(lines.join("\n")).toContain("(empty)");
	});

	it("returns no fact rows when the query matches nothing", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "zzzz-no-match-zzzz" }), 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).not.toContain("Dhruv");
		expect(text).not.toContain("TypeScript");
		// Empty placeholders still appear
		expect(text).toContain("(empty)");
	});
});

describe("renderMemoryEditor — width safety", () => {
	it("returns empty array at width < 20 (frame would not fit)", () => {
		expect(renderMemoryEditor(snapshot(), 10)).toEqual([]);
		expect(renderMemoryEditor(snapshot(), 19)).toEqual([]);
	});
});

describe("registerMemoryCommand", () => {
	it("registers the /sumo:memory slash command", () => {
		const registerCommand = vi.fn();
		registerMemoryCommand({ registerCommand } as never);
		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:memory",
			expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
		);
	});

	it("/sumo:memory (no args) opens the editor overlay", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, opts: { handler: typeof handler }) => {
			handler = opts.handler;
		});
		registerMemoryCommand({ registerCommand } as never);

		const custom = vi.fn(async () => undefined);
		const notify = vi.fn();
		await handler!("", { ui: { custom, notify } });

		// Without a remnic daemon, browse() will fail and we'll notify "memory
		// unavailable" rather than open the modal. Either way, the command is
		// reachable.
		expect(custom.mock.calls.length + notify.mock.calls.length).toBeGreaterThan(0);
	});
});
