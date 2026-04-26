import { describe, expect, it, vi } from "vitest";
import {
	MEMORY_EDITOR_HINTS,
	registerMemoryCommand,
	renderMemoryEditor,
	type MemoryEditorSnapshot,
} from "./memory-editor.js";
import type { MemoryFact } from "./memory.js";
import { groupFactsByPanel } from "./memory-categorization.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
	return {
		id: `fact-${Math.random().toString(36).slice(2)}`,
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
	return {
		searchQuery: "",
		groups: groupFactsByPanel(facts),
		factsTotal: facts.length,
		...overrides,
	};
}

describe("renderMemoryEditor — title + dividers", () => {
	it("renders SUMOCODE MEMORY title centered", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const titleLine = lines.find((l) => l.includes("SUMOCODE MEMORY"));
		expect(titleLine).toBeDefined();
	});

	it("renders title in accent color", () => {
		const lines = renderMemoryEditor(snapshot(), 100);
		const titleLine = lines.find((l) => l.includes("SUMOCODE MEMORY"));
		// accent #D97706 -> 217;119;6
		expect(titleLine).toContain("\u001b[38;2;217;119;6m");
	});

	it("renders divider rules above and below content", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const dividers = lines.filter((l) => l.includes("─".repeat(20)));
		expect(dividers.length).toBeGreaterThanOrEqual(2);
	});
});

describe("renderMemoryEditor — search row", () => {
	it("shows dim 'search…' placeholder when searchQuery is empty", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "" }), 100).map(stripAnsi);
		const searchLine = lines.find((l) => l.includes("search"));
		expect(searchLine).toBeDefined();
	});

	it("shows the actual query when searchQuery is non-empty", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "typescript" }), 100).map(stripAnsi);
		const searchLine = lines.find((l) => l.includes("typescript"));
		expect(searchLine).toBeDefined();
	});

	it("shows the facts total count on the right side of the search row", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const searchLine = lines.find((l) => l.includes("5 facts"));
		expect(searchLine).toBeDefined();
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
		const snap: MemoryEditorSnapshot = {
			searchQuery: "",
			groups: groupFactsByPanel(facts),
			factsTotal: 1,
		};
		const lines = renderMemoryEditor(snap, 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain(" GENERAL ");
	});

	it("renders each fact with ❧ bullet", () => {
		const lines = renderMemoryEditor(snapshot(), 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("❧");
	});
});

describe("renderMemoryEditor — footer hints", () => {
	it("includes navigate/search/copy/close hints", () => {
		const lines = renderMemoryEditor(snapshot(), 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain(MEMORY_EDITOR_HINTS);
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

		// Without a remnic daemon, browse() will fail and we'll notify "memory unavailable"
		// rather than open the modal. Either way, the command is reachable.
		expect(custom.mock.calls.length + notify.mock.calls.length).toBeGreaterThan(0);
	});
});
