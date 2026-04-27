import { describe, expect, it, vi } from "vitest";
import { MemoryClientError, type RemnicMemoryClient } from "./memory.js";
import {
	SIDEBAR_MEMORY_DEBOUNCE_MS,
	SIDEBAR_MEMORY_RETRY_MS,
	SIDEBAR_MIN_TERMINAL_WIDTH,
	SIDEBAR_WIDTH,
	StaticSidebarDock,
	dockStaticSidebar,
	chooseSidebarAnchor,
	createSidebarMemoryCache,
	renderSidebar,
	type SidebarSnapshot,
} from "./sidebar.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function memoryClient(query: RemnicMemoryClient["query"]): RemnicMemoryClient {
	return {
		query,
		status: vi.fn(),
		add: vi.fn(),
		forget: vi.fn(),
		browse: vi.fn(async () => []),
	};
}

function component(lines: string[]): { renderCalls: number[]; node: { render(width: number): string[]; invalidate(): void } } {
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
		projectName: "argent-x",
		branch: "main",
		inputTokens: 12_000,
		outputTokens: 8_000,
		contextWindow: 200_000,
		costUsd: 0.42,
		mcpServers: [
			{ name: "github", status: "idle" },
			{ name: "stitch", status: "tool" },
		],
		memory: [
			"prefers pnpm",
			"never autoformat go",
			"writes commits in cathedral voice",
		],
		memoryTotal: 3,
		...overrides,
	};
}

describe("StaticSidebarDock", () => {
	it("renders the chat column at a reduced width and appends the sidebar top-aligned in reserved columns", () => {
		const left = component(["hello from chat", "second line", "third line"]);
		const right = component(["CTX", "MCP"]);
		const dock = new StaticSidebarDock([left.node], right.node, () => true);

		const lines = dock.render(160).map(stripAnsi);

		expect(left.renderCalls).toEqual([160 - SIDEBAR_WIDTH - 1]);
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

describe("createSidebarMemoryCache", () => {
	it("queries Remnic and exposes the latest fact text for rendering", async () => {
		const cache = createSidebarMemoryCache(memoryClient(vi.fn(async () => [
			{ id: "1", text: "prefers pnpm" },
			{ id: "2", text: "uses Cathedral" },
		])));

		await cache.refresh("package manager");

		expect(cache.snapshot()).toEqual({
			memory: ["prefers pnpm", "uses Cathedral"],
			memoryUnavailable: false,
		});
	});

	it("marks memory unavailable when Remnic cannot answer", async () => {
		const cache = createSidebarMemoryCache(memoryClient(vi.fn(async () => {
			throw new MemoryClientError("daemon_down", "memory unavailable");
		})));

		await cache.refresh("anything");

		expect(cache.snapshot()).toEqual({ memory: [], memoryUnavailable: true });
	});

	it("debounces prompt refreshes and only queries the latest prompt", async () => {
		vi.useFakeTimers();
		try {
			const query = vi.fn(async () => [{ id: "latest", text: "convex preference" }]);
			const onChange = vi.fn();
			const cache = createSidebarMemoryCache(memoryClient(query));

			cache.schedule("auth", onChange);
			cache.schedule("convex", onChange);
			expect(query).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(SIDEBAR_MEMORY_DEBOUNCE_MS);

			expect(query).toHaveBeenCalledTimes(1);
			expect(query).toHaveBeenCalledWith("convex", 5);
			expect(cache.snapshot().memory).toEqual(["convex preference"]);
			expect(onChange).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not query or retry for an empty splash prompt", async () => {
		vi.useFakeTimers();
		try {
			const query = vi.fn(async () => [{ id: "unused", text: "unused" }]);
			const onChange = vi.fn();
			const cache = createSidebarMemoryCache(memoryClient(query));

			cache.schedule("   ", onChange);
			await vi.advanceTimersByTimeAsync(SIDEBAR_MEMORY_DEBOUNCE_MS + SIDEBAR_MEMORY_RETRY_MS);

			expect(query).not.toHaveBeenCalled();
			expect(onChange).not.toHaveBeenCalled();
			expect(cache.snapshot()).toEqual({ memory: [], memoryUnavailable: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it("auto-retries after daemon-down and recovers without a new prompt", async () => {
		vi.useFakeTimers();
		try {
			const query = vi
				.fn<RemnicMemoryClient["query"]>()
				.mockRejectedValueOnce(new MemoryClientError("daemon_down", "memory unavailable"))
				.mockResolvedValueOnce([{ id: "recovered", text: "memory is back" }]);
			const onChange = vi.fn();
			const cache = createSidebarMemoryCache(memoryClient(query));

			cache.schedule("sumocode", onChange);
			await vi.advanceTimersByTimeAsync(SIDEBAR_MEMORY_DEBOUNCE_MS);
			expect(cache.snapshot()).toEqual({ memory: [], memoryUnavailable: true });

			await vi.advanceTimersByTimeAsync(SIDEBAR_MEMORY_RETRY_MS);

			expect(query).toHaveBeenCalledTimes(2);
			expect(query).toHaveBeenLastCalledWith("sumocode", 5);
			expect(cache.snapshot()).toEqual({ memory: ["memory is back"], memoryUnavailable: false });
			expect(onChange).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("suppresses repeated daemon-down renders while continuing retry probes", async () => {
		vi.useFakeTimers();
		try {
			const query = vi.fn<RemnicMemoryClient["query"]>().mockRejectedValue(new MemoryClientError("daemon_down", "memory unavailable"));
			const onChange = vi.fn();
			const cache = createSidebarMemoryCache(memoryClient(query));

			cache.schedule("sumocode", onChange);
			await vi.advanceTimersByTimeAsync(SIDEBAR_MEMORY_DEBOUNCE_MS);
			await vi.advanceTimersByTimeAsync(SIDEBAR_MEMORY_RETRY_MS * 2);

			expect(query).toHaveBeenCalledTimes(3);
			expect(cache.snapshot()).toEqual({ memory: [], memoryUnavailable: true });
			expect(onChange).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("sidebar layout constants", () => {
	it("defaults to the cathedral 49-column sidebar", () => {
		expect(SIDEBAR_WIDTH).toBe(49);
	});

	it("only mounts at the wide-layout threshold from DESIGN.md §8 (≥ 120 cols)", () => {
		expect(SIDEBAR_MIN_TERMINAL_WIDTH).toBe(120);
	});
});

describe("renderSidebar — surface", () => {
	it("pads every line to exactly the requested width so the surface fills cleanly", () => {
		const width = 49;
		const lines = renderSidebar(snapshot(), width);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(stripAnsi(line).length, `line was not padded to ${width}: ${JSON.stringify(stripAnsi(line))}`).toBe(width);
		}
	});

	it("wraps every line in the cathedral mahogany surface background", () => {
		const lines = renderSidebar(snapshot(), 49);
		for (const line of lines) {
			// #241D17 -> 36;29;23
			expect(line).toContain("\u001b[48;2;36;29;23m");
		}
	});
});

describe("renderSidebar — context section", () => {
	it("shows project (branch), a filled progress bar, and a 'spent · session' line", () => {
		const lines = renderSidebar(snapshot(), 49).map(stripAnsi);
		const blob = lines.join("\n");

		expect(blob).toContain("CONTEXT");
		expect(blob).toContain("argent-x (main)");
		expect(blob).toMatch(/\[█+░+\] +20k\/200k/);
		expect(blob).toContain("$0.42 spent · session");
	});
});

describe("renderSidebar — mcp section", () => {
	it("lists each MCP server with a colored status dot and a right-aligned status pill", () => {
		const rendered = renderSidebar(snapshot(), 49);
		const blob = rendered.map(stripAnsi).join("\n");

		expect(blob).toContain("MCP");
		expect(blob).toContain("github");
		expect(blob).toContain("stitch");

		const githubRow = rendered.find((line) => line.includes("github"));
		const stitchRow = rendered.find((line) => line.includes("stitch"));

		expect(githubRow).toBeDefined();
		expect(stitchRow).toBeDefined();
		expect(githubRow).toContain("127;176;105"); // #7FB069 idle (green) dot
		expect(stitchRow).toContain("91;155;213"); // #5B9BD5 tool (blue) dot

		// Status pill text right-aligned at the end of the row.
		expect(stripAnsi(githubRow!)).toMatch(/idle\s*$/);
		expect(stripAnsi(stitchRow!)).toMatch(/tool\s*$/);
	});
});

describe("renderSidebar — MEMORY sub-tab active", () => {
	it("renders each memory item with a ❧ bullet (when activeSubTab=MEMORY)", () => {
		const lines = renderSidebar(snapshot({ activeSubTab: "MEMORY" }), 49);
		const memoryLines = lines.map(stripAnsi).filter((l) => /^\s*❧/.test(l));

		expect(memoryLines.length).toBe(3);
		expect(memoryLines[0]).toContain("prefers pnpm");
		expect(memoryLines[1]).toContain("never autoformat go");
	});

	it("caps display at the first 5 memory items even if more are supplied", () => {
		const many = snapshot({
			activeSubTab: "MEMORY",
			memory: ["a", "b", "c", "d", "e", "f", "g"],
		});
		const lines = renderSidebar(many, 49);
		const memoryLines = lines.map(stripAnsi).filter((l) => /^\s*❧/.test(l));

		expect(memoryLines.length).toBe(5);
		expect(memoryLines[4]).toContain("e");
		expect(memoryLines.some((l) => l.includes("f"))).toBe(false);
	});

	it("shows dim no-match copy when memory is healthy but empty", () => {
		const lines = renderSidebar(snapshot({ activeSubTab: "MEMORY", memory: [], memoryUnavailable: false }), 49);
		const row = lines.find((line) => stripAnsi(line).includes("no memory match"));

		expect(row).toBeDefined();
		expect(row).toContain("\u001b[2m");
		expect(lines.map(stripAnsi).filter((line) => /^\s*❧/.test(line))).toHaveLength(0);
	});

	it("shows dim memory unavailable copy when the daemon is down", () => {
		const lines = renderSidebar(snapshot({ activeSubTab: "MEMORY", memory: [], memoryUnavailable: true }), 49);
		const row = lines.find((line) => stripAnsi(line).includes("memory unavailable"));

		expect(row).toBeDefined();
		expect(row).toContain("\u001b[2m");
		expect(lines.map(stripAnsi).filter((line) => /^\s*❧/.test(line))).toHaveLength(0);
	});

	it("shows a 'N more · ⌘M' footer when memoryTotal exceeds shown facts", () => {
		const lines = renderSidebar(snapshot({
			activeSubTab: "MEMORY",
			memory: ["a", "b", "c", "d", "e"],
			memoryTotal: 53,
		}), 49);
		const blob = lines.map(stripAnsi).join("\n");

		expect(blob).toContain("48 more · ⌘M");
	});

	it("omits the 'N more · ⌘M' footer when memoryTotal equals shown facts", () => {
		const lines = renderSidebar(snapshot({
			activeSubTab: "MEMORY",
			memory: ["a", "b", "c"],
			memoryTotal: 3,
		}), 49);
		const blob = lines.map(stripAnsi).join("\n");

		expect(blob).not.toContain("more · ⌘M");
	});
});

describe("renderSidebar — sub-tab navigation", () => {
	it("defaults to CONTEXT sub-tab (no activeSubTab field)", () => {
		const lines = renderSidebar(snapshot(), 49);
		const blob = lines.map(stripAnsi).join("\n");
		expect(blob).toContain("REGISTRY");
		expect(blob).toContain("CONTEXT");
		expect(blob).toContain("MEMORY");
		// CONTEXT sub-tab content shown
		expect(blob).toContain("argent-x");
		expect(blob).toContain("github");
		// MEMORY sub-tab content NOT shown (no ❧ bullets)
		expect(lines.map(stripAnsi).filter((line) => /^\s*❧/.test(line))).toHaveLength(0);
	});

	it("renders REGISTRY header with v 1.0.0 version line", () => {
		const lines = renderSidebar(snapshot(), 49).map(stripAnsi);
		const hasRegistry = lines.some((l) => l.includes("REGISTRY"));
		const hasVersion = lines.some((l) => l.includes("v 1.0.0"));
		expect(hasRegistry).toBe(true);
		expect(hasVersion).toBe(true);
	});

	it("marks active session with ◆ and archived sessions with ▢", () => {
		const lines = renderSidebar(snapshot({
			sessions: [
				{ name: "sumocode", branch: "main", active: true },
				{ name: "sumocode", branch: "other-branch", active: false },
			],
		}), 49).map(stripAnsi);
		const activeSession = lines.find((l) => l.includes("sumocode (main)"));
		const archivedSession = lines.find((l) => l.includes("sumocode (other-branch)"));
		expect(activeSession).toContain("◆");
		expect(archivedSession).toContain("▢");
	});

	it("marks active sub-tab with ◆ (filled) and inactive with ▢ (outlined)", () => {
		const lines = renderSidebar(snapshot({ activeSubTab: "CONTEXT" }), 49).map(stripAnsi);
		const contextRow = lines.find((l) => l.includes("CONTEXT") && !l.includes("ACTIVE_CONTEXT"));
		const memoryRow = lines.find((l) => l.includes("MEMORY") && !l.includes("ACTIVE_MEMORY"));
		expect(contextRow).toBeDefined();
		expect(memoryRow).toBeDefined();
		expect(contextRow).toContain("◆");
		expect(memoryRow).toContain("▢");
	});

	it("switching activeSubTab swaps content (CONTEXT → MEMORY)", () => {
		const contextLines = renderSidebar(snapshot({ activeSubTab: "CONTEXT" }), 49).map(stripAnsi);
		const memoryLines = renderSidebar(snapshot({ activeSubTab: "MEMORY" }), 49).map(stripAnsi);

		const contextHasMcp = contextLines.some((l) => l.includes("github"));
		const memoryHasMcp = memoryLines.some((l) => l.includes("github"));
		expect(contextHasMcp).toBe(true);
		expect(memoryHasMcp).toBe(false);

		const memoryHasBullets = memoryLines.some((l) => /^\s*❧/.test(l));
		expect(memoryHasBullets).toBe(true);
	});
});

describe("renderSidebar — memory section bullet indent", () => {
	it("renders each memory item with a leading two-space indent before ❧", () => {
		const lines = renderSidebar(snapshot({ activeSubTab: "MEMORY" }), 49);
		const memoryLines = lines.map(stripAnsi).filter((line) => /^\s*❧/.test(line));

		expect(memoryLines.length).toBeGreaterThan(0);
		for (const line of memoryLines) {
			expect(line.startsWith("  ❧"), `expected '  ❧...' indent on: ${line}`).toBe(true);
		}
	});
});

describe("chooseSidebarAnchor", () => {
	it("defaults to right-center on landscape monitors", () => {
		expect(chooseSidebarAnchor(200, 60)).toBe("right-center");
	});

	it("defaults to top-right on portrait monitors", () => {
		expect(chooseSidebarAnchor(60, 160)).toBe("top-right");
	});

	it("honors a per-machine override over the default", () => {
		expect(chooseSidebarAnchor(200, 60, "bottom-right")).toBe("bottom-right");
		expect(chooseSidebarAnchor(60, 160, "right-center")).toBe("right-center");
	});
});
