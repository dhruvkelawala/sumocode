import { describe, expect, it, vi } from "vitest";
import {
	SIDEBAR_MIN_TERMINAL_WIDTH,
	SIDEBAR_WIDTH,
	StaticSidebarDock,
	dockStaticSidebar,
	chooseSidebarAnchor,
	renderSidebar,
	type SidebarSnapshot,
} from "./sidebar.js";

// oxlint-disable-next-line no-control-regex -- intentional ANSI SGR escape match to strip styling in captured output
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");
const untrack = (s: string): string => s.replace(/\u202F/g, "");

function component(lines: string[]) {
	const renderCalls: number[] = [];
	return {
		renderCalls,
		node: {
			render(width: number): string[] {
				renderCalls.push(width);
				return lines;
			},
			invalidate(): void {},
		},
	};
}

function snapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
	return {
		projectName: "main-app",
		branch: "main",
		inputTokens: 12_000,
		outputTokens: 8_000,
		contextWindow: 200_000,
		costUsd: 0.42,
		mcpServers: [
			{ name: "github", status: "idle" },
			{ name: "stitch", status: "tool" },
		],
		...overrides,
	};
}

describe("StaticSidebarDock", () => {
	it("renders the chat column at a reduced width and appends the sidebar top-aligned in reserved columns", () => {
		const left = component(["hello from chat", "second line", "third line"]);
		const right = component(["CTX", "MCP"]);
		const dock = new StaticSidebarDock([left.node], right.node, () => true);

		const lines = dock.render(160).map(stripAnsi);

		expect(left.renderCalls).toEqual([160 - SIDEBAR_WIDTH - 2]);
		expect(right.renderCalls).toEqual([SIDEBAR_WIDTH]);
		expect(lines[0]).toContain("hello from chat");
		expect(lines[0]).toContain("CTX");
		expect(lines[1]).toContain("second line");
		expect(lines[1]).toContain("MCP");
		expect(lines[2]).toContain("third line");
		expect(lines[2]).not.toContain("CTX");
		expect(lines[2]).not.toContain("MCP");
		expect(lines[0]?.length).toBeLessThanOrEqual(160);
	});

	it("hides the sidebar entirely while the session has no messages (cathedral splash discipline)", () => {
		const left = component(["splash + input"]);
		const right = component(["SIDE"]);
		const dock = new StaticSidebarDock([left.node], right.node, () => false);

		const lines = dock.render(160).map(stripAnsi);

		expect(left.renderCalls).toEqual([160]);
		expect(right.renderCalls).toEqual([]);
		expect(lines).toEqual(["splash + input"]);
	});

	it("does not render the sidebar below the wide-layout threshold", () => {
		const left = component(["full width chat"]);
		const right = component(["SIDE"]);
		const dock = new StaticSidebarDock([left.node], right.node, () => true);

		const lines = dock.render(SIDEBAR_MIN_TERMINAL_WIDTH - 1).map(stripAnsi);

		expect(left.renderCalls).toEqual([SIDEBAR_MIN_TERMINAL_WIDTH - 1]);
		expect(right.renderCalls).toEqual([]);
		expect(lines).toEqual(["full width chat"]);
	});

	it("fills blank sidebar rows with surface bg when chat is taller than sidebar content", () => {
		const chatRows = Array.from({ length: 30 }, (_, i) => `chat row ${i}`);
		const left = component(chatRows);
		const sidebarContent = ["SIDE 1", "SIDE 2"];
		const right = component(sidebarContent);
		const dock = new StaticSidebarDock([left.node], right.node, () => true);

		const lines = dock.render(160);

		expect(lines).toHaveLength(30);
		// Row beyond sidebar content should still have surface bg (#241D17 → 36;29;23)
		const lastRow = lines[29]!;
		expect(lastRow).toContain("\u001b[48;2;36;29;23m");
		// And should be padded to sidebar width
		const sidebarPart = stripAnsi(lastRow).slice(-SIDEBAR_WIDTH);
		expect(sidebarPart.length).toBe(SIDEBAR_WIDTH);
		expect(sidebarPart.trim()).toBe("");
	});

	it("sidebar stays identical when chat content changes (scroll independence)", () => {
		const sidebarNode = component(["REGISTRY", "CONTEXT", "MCP"]).node;

		// First render: short chat
		const chatShort = component(["msg 1", "msg 2"]);
		const dockA = new StaticSidebarDock([chatShort.node], sidebarNode, () => true);
		const linesA = dockA.render(160);

		// Second render: long chat (simulates scrolling to more messages)
		const chatLong = component(["msg 1", "msg 2", "msg 3", "msg 4", "msg 5", "msg 6", "msg 7"]);
		const dockB = new StaticSidebarDock([chatLong.node], sidebarNode, () => true);
		const linesB = dockB.render(160);

		// Sidebar occupies cols 130-159 in a 160-col terminal (128 chat + 2 gutter + 30 sidebar)
		const sidebarColsA = linesA.map((l) => stripAnsi(l).slice(-SIDEBAR_WIDTH));
		const sidebarColsB = linesB.slice(0, linesA.length).map((l) => stripAnsi(l).slice(-SIDEBAR_WIDTH));

		// Sidebar content in the overlapping rows must be identical regardless of chat changes
		expect(sidebarColsA).toEqual(sidebarColsB);
		// Chat grew but sidebar content stays the same
		expect(linesB).toHaveLength(7);
		expect(linesA).toHaveLength(2);
	});

	it("clips tall sidebar content to the main column height so editor/footer stay pinned", () => {
		const left = component(["chat row"]);
		const right = component(["SIDE 1", "SIDE 2", "SIDE 3"]);
		const dock = new StaticSidebarDock([left.node], right.node, () => true);

		const lines = dock.render(160).map(stripAnsi);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("chat row");
		expect(lines[0]).toContain("SIDE 1");
		expect(lines[0]).not.toContain("SIDE 2");
	});
});

describe("dockStaticSidebar", () => {
	it("wraps header, chat, pending, and status root containers in a static split and can restore them", () => {
		const header = component(["header"]).node;
		const chat = component(["chat"]).node;
		const pending = component(["pending"]).node;
		const status = component(["status"]).node;
		const editor = component(["editor"]).node;
		const sidebar = component(["side"]).node;
		const tui = { children: [header, chat, pending, status, editor], requestRender: vi.fn() };

		const restore = dockStaticSidebar(tui, sidebar, () => true);

		expect(restore).toBeTypeOf("function");
		expect(tui.children).toHaveLength(2);
		expect(tui.children[0]).toBeInstanceOf(StaticSidebarDock);
		expect(tui.children[1]).toBe(editor);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		restore?.();

		expect(tui.children).toEqual([header, chat, pending, status, editor]);
	});

	it("refuses to mutate unexpected root layouts", () => {
		const header = component(["header"]).node;
		const chat = component(["chat"]).node;
		const sidebar = component(["side"]).node;
		const tui = { children: [header, chat], requestRender: vi.fn() };

		expect(dockStaticSidebar(tui, sidebar, () => true)).toBeUndefined();
		expect(tui.children).toEqual([header, chat]);
		expect(tui.requestRender).not.toHaveBeenCalled();
	});
});

describe("sidebar layout constants", () => {
	it("defaults to the cathedral 30-column sidebar", () => {
		expect(SIDEBAR_WIDTH).toBe(30);
	});

	it("only mounts at the wide-layout threshold from DESIGN.md §8 (≥ 120 cols)", () => {
		expect(SIDEBAR_MIN_TERMINAL_WIDTH).toBe(120);
	});
});

describe("renderSidebar — surface", () => {
	it("pads every line to exactly the requested width so the surface fills cleanly", () => {
		const width = SIDEBAR_WIDTH;
		const lines = renderSidebar(snapshot(), width);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(stripAnsi(line).length, `line was not padded to ${width}: ${JSON.stringify(stripAnsi(line))}`).toBe(width);
		}
	});

	it("wraps every line in the cathedral mahogany surface background", () => {
		const lines = renderSidebar(snapshot(), SIDEBAR_WIDTH);
		for (const line of lines) {
			// #241D17 -> 36;29;23
			expect(line).toContain("\u001b[48;2;36;29;23m");
		}
	});
});

describe("renderSidebar — context section", () => {
	it("shows project, branch, V2 token bar, and session totals", () => {
		const lines = renderSidebar(snapshot(), SIDEBAR_WIDTH).map(stripAnsi);
		const blob = untrack(lines.join("\n"));

		expect(blob).toContain("CONTEXT");
		expect(blob).toContain("main-app");
		expect(blob).toContain("on main");
		expect(blob).toMatch(/▉+░+/);
		expect(blob).toContain("20k / 200k");
		expect(blob).toContain("$0.42 · 20k cumul");
	});
});

describe("renderSidebar — mcp section", () => {
	it("lists each MCP server with a colored status dot and a right-aligned status pill", () => {
		const rendered = renderSidebar(snapshot(), SIDEBAR_WIDTH);
		const blob = rendered.map(stripAnsi).join("\n");

		expect(untrack(blob)).toContain("MCP");
		expect(blob).toContain("github");
		expect(blob).toContain("stitch");

		const githubRow = rendered.find((line) => line.includes("github"));
		const stitchRow = rendered.find((line) => line.includes("stitch"));

		expect(githubRow).toBeDefined();
		expect(stitchRow).toBeDefined();
		expect(githubRow).toContain("139;122;99"); // #8B7A63 idle dot (foregroundDim)
		expect(stitchRow).toContain("232;179;57"); // #E8B339 in-flight dot (amber)

		// Status pill text right-aligned at the end of the row.
		expect(stripAnsi(githubRow!)).toMatch(/idle\s*$/);
		expect(stripAnsi(stitchRow!)).toMatch(/in-flight\s*$/);
	});
});

describe("renderSidebar — registry", () => {
	it("shows context and MCP without memory navigation or daemon copy", () => {
		const lines = renderSidebar(snapshot(), SIDEBAR_WIDTH).map(stripAnsi);
		const blob = untrack(lines.join("\n"));
		expect(blob).toContain("REGISTRY");
		expect(blob).toContain("◆ CONTEXT");
		expect(blob).toContain("main-app");
		expect(blob).toContain("github");
		expect(blob).not.toMatch(/MEMORY|memory|⌘M|▢|❧/);
	});

	it("renders REGISTRY header without version metadata", () => {
		const lines = renderSidebar(snapshot(), SIDEBAR_WIDTH).map(stripAnsi);
		const hasRegistry = lines.some((l) => l.includes("REGISTRY"));
		const hasVersion = lines.some((l) => l.includes("v 1.0.0"));
		expect(hasRegistry).toBe(true);
		expect(hasVersion).toBe(false);
	});

	it("renders project and branch as editorial hero values", () => {
		const lines = renderSidebar(snapshot({ projectName: "sumocode", branch: "main" }), SIDEBAR_WIDTH).map(stripAnsi);
		const blob = lines.join("\n");
		expect(blob).toContain("sumocode");
		expect(blob).toContain("on main");
	});
});

describe("chooseSidebarAnchor", () => {
	it("defaults to right-center on landscape monitors", () => {
		expect(chooseSidebarAnchor(200, 60)).toBe("right-center");
	});

	it("keeps the legacy portrait anchor stable for future overlays", () => {
		expect(chooseSidebarAnchor(60, 160)).toBe("top-right");
	});

	it("honors a per-machine override over the default", () => {
		expect(chooseSidebarAnchor(200, 60, "bottom-right")).toBe("bottom-right");
		expect(chooseSidebarAnchor(60, 160, "right-center")).toBe("right-center");
	});
});
