import { describe, expect, it, vi } from "vitest";
import {
	MEMORY_EDITOR_HINTS,
	MemoryEditorComponent,
	registerMemoryCommand,
	renderMemoryEditor,
	type MemoryEditorSnapshot,
} from "./memory-editor.js";
import type { MemoryFact, RemnicMemoryClient } from "./memory.js";
import { groupFactsByPanel } from "./memory-categorization.js";

const ANSI = /\u001b\[[0-9;]*m/g;
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
		fact({ id: "id-1", text: "Dhruv works at Argent in London" }),     // IDENTITY
		fact({ id: "pref-1", text: "prefers TypeScript strict" }),         // PREFERENCES
		fact({ id: "wf-1", text: "always use TDD for new features" }),     // WORKFLOW
		fact({ id: "proj-1", text: "SumoCode is the cathedral product" }),  // PROJECTS
		fact({ id: "sys-1", text: "mac mini in portrait orientation" }),   // SYSTEM
	];
	return {
		searchQuery: "",
		groups: groupFactsByPanel(facts),
		factsTotal: facts.length,
		focusedFactId: null,
		...overrides,
	};
}

function fakeClient(overrides: Partial<RemnicMemoryClient> = {}): RemnicMemoryClient {
	return {
		browse: vi.fn(async () => []),
		add: vi.fn(async () => undefined),
		forget: vi.fn(async () => undefined),
		search: vi.fn(async () => []),
		...overrides,
	} as RemnicMemoryClient;
}

describe("renderMemoryEditor — title + dividers", () => {
	it("renders MEMORY SCRIPTORIUM title centered with floral marks", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const titleLine = lines.find((l) => l.includes("MEMORY SCRIPTORIUM"));
		expect(titleLine).toBeDefined();
		expect(titleLine).toContain("✾");
	});

	it("renders title in accent color", () => {
		const lines = renderMemoryEditor(snapshot(), 100);
		const titleLine = lines.find((l) => l.includes("MEMORY SCRIPTORIUM"));
		// cathedral accent #D97706 -> 217;119;6
		expect(titleLine).toContain("\u001b[38;2;217;119;6m");
	});

	it("renders split rule dividers above and below content", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const dividers = lines.filter((l) => l.includes("─".repeat(20)) && l.includes("·"));
		expect(dividers.length).toBeGreaterThanOrEqual(2);
	});
});

describe("renderMemoryEditor — search row", () => {
	it("shows dim 'search remembered facts…' placeholder when searchQuery is empty", () => {
		const lines = renderMemoryEditor(snapshot({ searchQuery: "" }), 100).map(stripAnsi);
		const searchLine = lines.find((l) => l.includes("search remembered facts"));
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

	it("uses a chevron prompt glyph", () => {
		const lines = renderMemoryEditor(snapshot(), 100).map(stripAnsi);
		const searchLine = lines.find((l) => l.includes("❯"));
		expect(searchLine).toBeDefined();
	});
});

describe("renderMemoryEditor — panel grid", () => {
	it("renders each non-empty panel header", () => {
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
		const facts = [fact({ id: "general-1", text: "the sky is blue" })];
		const snap: MemoryEditorSnapshot = {
			searchQuery: "",
			groups: groupFactsByPanel(facts),
			factsTotal: 1,
			focusedFactId: null,
		};
		const lines = renderMemoryEditor(snap, 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain(" GENERAL ");
	});

	it("marks the focused fact with the focused glyph", () => {
		const lines = renderMemoryEditor(snapshot({ focusedFactId: "pref-1" }), 160).map(stripAnsi);
		const focusedSegment = lines
			.flatMap((l) => l.split("│"))
			.find((segment) => segment.includes("prefers TypeScript strict"));
		const otherSegment = lines
			.flatMap((l) => l.split("│"))
			.find((segment) => segment.includes("Dhruv works at Argent"));
		expect(focusedSegment).toContain("❈");
		expect(focusedSegment).not.toContain("·");
		expect(otherSegment).toContain("·");
		expect(otherSegment).not.toContain("❈");
	});
});

describe("renderMemoryEditor — footer hints", () => {
	it("includes the cathedral-voice hints", () => {
		const lines = renderMemoryEditor(snapshot(), 160).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain(MEMORY_EDITOR_HINTS);
	});
});

describe("MemoryEditorComponent — interaction", () => {
	function buildComponent(initial?: Partial<MemoryEditorSnapshot>, overrides: { client?: RemnicMemoryClient } = {}) {
		const client = overrides.client ?? fakeClient();
		const notify = vi.fn<(message: string, level?: "info" | "warning") => void>();
		const invalidate = vi.fn<() => void>();
		const close = vi.fn<() => void>();
		const component = new MemoryEditorComponent(snapshot(initial), { client, notify, invalidate, close });
		return { component, client, notify, invalidate, close };
	}

	it("focuses the first visible fact when none is preselected", () => {
		const { component } = buildComponent({ focusedFactId: null });
		const lines = component.render(160).map(stripAnsi).join("\n");
		expect(lines).toContain("❈");
	});

	it("filters facts as the user types", () => {
		const { component, invalidate } = buildComponent();
		component.handleInput("t");
		component.handleInput("y");
		component.handleInput("p");
		const lines = component.render(160).map(stripAnsi).join("\n");
		expect(lines).toContain("prefers TypeScript strict");
		expect(lines).not.toContain("Dhruv works at Argent");
		expect(invalidate).toHaveBeenCalled();
	});

	it("walks focus across visible facts with arrow keys", () => {
		const { component } = buildComponent({ focusedFactId: "pref-1" });
		component.handleInput("down");
		const next = component.render(160).map(stripAnsi).join("\n");
		// focus moves off the previous fact line
		const focusedLine = next.split("\n").find((l) => l.includes("❈"));
		expect(focusedLine).toBeDefined();
		expect(focusedLine).not.toContain("prefers TypeScript strict");
	});

	it("forgets the focused fact via the client and removes it optimistically", async () => {
		const forget = vi.fn(async () => undefined);
		const { component, notify, client } = buildComponent({ focusedFactId: "pref-1" }, {
			client: fakeClient({ forget }),
		});
		// initial render shows the fact
		expect(component.render(160).map(stripAnsi).join("\n")).toContain("prefers TypeScript strict");
		component.handleInput("d");
		// optimistic removal: rendered immediately
		expect(component.render(160).map(stripAnsi).join("\n")).not.toContain("prefers TypeScript strict");
		// allow the awaited client.forget to resolve
		await Promise.resolve();
		await Promise.resolve();
		expect(forget).toHaveBeenCalledWith("pref-1");
		expect(notify).toHaveBeenCalledWith("forgotten", "info");
		expect(client).toBeDefined();
	});

	it("rolls back the optimistic removal when forget rejects", async () => {
		let reject: (error: Error) => void = () => {};
		const forget = vi.fn(() => new Promise<void>((_, rej) => { reject = rej; }));
		const { component, notify } = buildComponent({ focusedFactId: "pref-1" }, {
			client: fakeClient({ forget }),
		});
		component.handleInput("d");
		expect(component.render(160).map(stripAnsi).join("\n")).not.toContain("prefers TypeScript strict");
		reject(new Error("nope"));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(component.render(160).map(stripAnsi).join("\n")).toContain("prefers TypeScript strict");
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/forget failed: nope/), "warning");
	});

	it("notifies a hint when the user presses e (revise inline deferred)", () => {
		const { component, notify } = buildComponent({ focusedFactId: "pref-1" });
		component.handleInput("e");
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/revise inline coming soon/), "info");
	});

	it("closes on escape", () => {
		const { component, close } = buildComponent();
		component.handleInput("escape");
		expect(close).toHaveBeenCalled();
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

	it("/sumo:memory (no args) reaches the editor or notifies unavailable", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, opts: { handler: typeof handler }) => {
			handler = opts.handler;
		});
		registerMemoryCommand({ registerCommand } as never);

		const custom = vi.fn(async () => undefined);
		const notify = vi.fn();
		await handler!("", { ui: { custom, notify } });

		expect(custom.mock.calls.length + notify.mock.calls.length).toBeGreaterThan(0);
	});
});
