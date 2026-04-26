import { describe, expect, it, vi } from "vitest";
import { MemoryClientError, type RemnicMemoryClient } from "./memory.js";
import {
	SIDEBAR_MEMORY_DEBOUNCE_MS,
	SIDEBAR_MEMORY_RETRY_MS,
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
	};
}

function snapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
	return {
		projectName: "argent-x",
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
		...overrides,
	};
}

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
});

describe("renderSidebar — surface", () => {
	it("pads every line to exactly the requested width so the surface fills cleanly", () => {
		const width = 32;
		const lines = renderSidebar(snapshot(), width);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(stripAnsi(line).length, `line was not padded to ${width}: ${JSON.stringify(stripAnsi(line))}`).toBe(width);
		}
	});

	it("wraps every line in the cathedral mahogany surface background", () => {
		const lines = renderSidebar(snapshot(), 32);
		for (const line of lines) {
			// #241D17 -> 36;29;23
			expect(line).toContain("\u001b[48;2;36;29;23m");
		}
	});
});

describe("renderSidebar — context section", () => {
	it("shows the project name, a token gauge, and cost in a context block", () => {
		const lines = renderSidebar(snapshot(), 32).map(stripAnsi);
		const blob = lines.join("\n");

		expect(blob).toContain("CONTEXT");
		expect(blob).toContain("argent-x");
		expect(blob).toContain("20k/200k"); // 12k input + 8k output of 200k
		expect(blob).toContain("$0.42");
	});
});

describe("renderSidebar — mcp section", () => {
	it("lists each MCP server with a colored status dot", () => {
		const rendered = renderSidebar(snapshot(), 32);
		const blob = rendered.map(stripAnsi).join("\n");

		expect(blob).toContain("MCP");
		expect(blob).toContain("github");
		expect(blob).toContain("stitch");

		// Each MCP line carries a state-colored dot. The status row for github (idle)
		// must include the green idle hex; stitch (tool) must include the blue tool hex.
		const githubRow = rendered.find((line) => line.includes("github"));
		const stitchRow = rendered.find((line) => line.includes("stitch"));

		expect(githubRow).toBeDefined();
		expect(stitchRow).toBeDefined();
		expect(githubRow).toContain("127;176;105"); // #7FB069 idle (green)
		expect(stitchRow).toContain("91;155;213"); // #5B9BD5 tool (blue)
	});
});

describe("renderSidebar — memory section", () => {
	it("renders each memory item with a ❧ bullet", () => {
		const lines = renderSidebar(snapshot(), 32);
		const memoryLines = lines.map(stripAnsi).filter((l) => l.startsWith("❧"));

		expect(memoryLines.length).toBe(3);
		expect(memoryLines[0]).toContain("prefers pnpm");
		expect(memoryLines[1]).toContain("never autoformat go");
	});

	it("caps display at the first 5 memory items even if more are supplied", () => {
		const many = snapshot({
			memory: ["a", "b", "c", "d", "e", "f", "g"],
		});
		const lines = renderSidebar(many, 32);
		const memoryLines = lines.map(stripAnsi).filter((l) => l.startsWith("❧"));

		expect(memoryLines.length).toBe(5);
		expect(memoryLines[4]).toContain("e");
		expect(memoryLines.some((l) => l.includes("f"))).toBe(false);
	});

	it("shows dim memory unavailable copy when the daemon is down", () => {
		const lines = renderSidebar(snapshot({ memory: [], memoryUnavailable: true }), 32);
		const row = lines.find((line) => stripAnsi(line).includes("memory unavailable"));

		expect(row).toBeDefined();
		expect(row).toContain("\u001b[2m");
		expect(lines.map(stripAnsi).filter((line) => line.startsWith("❧"))).toHaveLength(0);
	});
});
