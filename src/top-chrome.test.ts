import { describe, expect, it, vi } from "vitest";
import {
	installTopChrome,
	renderTopChrome,
	renderTopChromeBlock,
	type TopChromeSnapshot,
	TOP_CHROME_BRAND,
} from "./top-chrome.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function snapshot(overrides: Partial<TopChromeSnapshot> = {}): TopChromeSnapshot {
	return {
		activeSession: { id: "abc", label: "refactor-auth-flow", state: "idle" },
		recentSessions: [
			{ id: "def", label: "debug-balance-tx" },
			{ id: "ghi", label: "index-issues" },
		],
		hidden: false,
		...overrides,
	};
}

describe("renderTopChrome", () => {
	it("renders with stable one-character outer padding", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(line).toHaveLength(160);
		expect(line.startsWith(` ${TOP_CHROME_BRAND}`)).toBe(true);
		expect(line.endsWith(" ")).toBe(true);
	});

	it("wraps compact portrait chrome with top/bottom breathing rows", () => {
		const lines = renderTopChromeBlock(snapshot(), 60).map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(" ".repeat(60));
		expect(lines[1]).toContain(TOP_CHROME_BRAND);
		expect(lines[2]).toBe(" ".repeat(60));
		expect(renderTopChromeBlock(snapshot(), 160)).toHaveLength(1);
	});

	it("wraps active session with ║ ║ and includes static active marker + label", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(line).toContain("║ • refactor-auth-flow ║");
	});

	it("uses static accent dot color regardless of active session state", () => {
		const line = renderTopChrome(snapshot({ activeSession: { id: "x", label: "live", state: "thinking" } }), 160);
		// accent #D97706 = 217;119;6
		expect(line).toContain("\u001b[38;2;217;119;6m•");
		// thinking #E8B339 = 232;179;57 must remain footer-owned
		expect(line).not.toContain("\u001b[38;2;232;179;57m");
	});

	it("supports small and large active marker dot sizes", () => {
		expect(stripAnsi(renderTopChrome(snapshot({ dotSize: "small" }), 160))).toContain("║ · refactor-auth-flow ║");
		expect(stripAnsi(renderTopChrome(snapshot({ dotSize: "large" }), 160))).toContain("║ ● refactor-auth-flow ║");
	});

	it("renders recent sessions as │ label", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(line).toContain("│ debug-balance-tx");
		expect(line).toContain("│ index-issues");
	});

	it("renders ARCHIVE link after recents", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		const archiveIdx = line.indexOf("ARCHIVE");
		const lastRecentIdx = line.lastIndexOf("index-issues");
		expect(archiveIdx).toBeGreaterThan(lastRecentIdx);
	});

	it("renders terminal and settings Octicons at the right edge", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(line).toContain("\uF489");
		expect(line).toContain("\uF423");
		const terminalIdx = line.indexOf("\uF489");
		const settingsIdx = line.indexOf("\uF423");
		expect(settingsIdx).toBeGreaterThan(terminalIdx);
		expect(line.trimEnd().endsWith("\uF423")).toBe(true);
	});

	it("when hidden=true, only SUMOCODE label is shown (nothing else)", () => {
		const line = stripAnsi(renderTopChrome(snapshot({ hidden: true }), 160));
		expect(line.trim()).toBe(TOP_CHROME_BRAND);
		expect(line).not.toContain("║");
		expect(line).not.toContain("│");
		expect(line).not.toContain("ARCHIVE");
		expect(line).not.toContain("\uF489");
		expect(line).not.toContain("\uF423");
	});

	it("at compact portrait width drops recents and ARCHIVE but keeps icons", () => {
		// Wide enough for everything.
		const wide = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(wide).toContain("\uF423");
		expect(wide).toContain("ARCHIVE");
		expect(wide).toContain("debug-balance-tx");

		// Portrait: keep brand + active + right icons, but collapse tab/archive text.
		const portrait = stripAnsi(renderTopChrome(snapshot(), 60));
		expect(portrait).toContain(TOP_CHROME_BRAND);
		expect(portrait).toContain("refactor-auth-flow");
		expect(portrait).toContain("\uF489");
		expect(portrait).toContain("\uF423");
		expect(portrait).not.toContain("ARCHIVE");
		expect(portrait).not.toContain("debug-balance-tx");
	});

	it("truncates very long session labels with ellipsis", () => {
		const longLabel = "a".repeat(100);
		const line = stripAnsi(
			renderTopChrome(snapshot({ activeSession: { id: "x", label: longLabel, state: "idle" } }), 80),
		);
		expect(line).toContain("…");
		expect(line.length).toBeLessThanOrEqual(80);
	});

	it("returns a single line not exceeding the requested width", () => {
		for (const w of [40, 80, 120, 160, 200]) {
			const line = renderTopChrome(snapshot(), w);
			expect(stripAnsi(line).length).toBeLessThanOrEqual(w);
			expect(line.includes("\n")).toBe(false);
		}
	});

	it("colors brand label in accent (#D97706)", () => {
		const line = renderTopChrome(snapshot(), 160);
		// 217;119;6 = #D97706
		expect(line).toContain("\u001b[38;2;217;119;6m");
	});

	it("renders session dividers and recent tabs in foregroundDim", () => {
		const line = renderTopChrome(snapshot(), 160);
		// accent #D97706 = 217;119;6 — used by SUMOCODE + active dot
		expect(line).toContain("\u001b[38;2;217;119;6m");
		// foregroundDim #8B7A63 = 139;122;99 — used by ║, │, recents, ARCHIVE
		expect(line).toContain("\u001b[38;2;139;122;99m");
	});

	it("works with zero recent sessions", () => {
		const line = stripAnsi(renderTopChrome(snapshot({ recentSessions: [] }), 160));
		expect(line).toContain(TOP_CHROME_BRAND);
		expect(line).toContain("refactor-auth-flow");
		expect(line).toContain("ARCHIVE");
		expect(line).not.toContain("│ debug");
	});
});


describe("installTopChrome", () => {
	it("hides the top chrome on splash and shows it after messages exist", () => {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();
		const on = vi.fn((event: string, handler: (event: unknown, ctx: unknown) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		});
		installTopChrome({ on } as never, () => snapshot({ recentSessions: [] }));

		let factory: ((tui: { requestRender(): void }) => { render(width: number): string[] }) | undefined;
		const ctx = {
			hasUI: true,
			ui: { setHeader: vi.fn((nextFactory: typeof factory) => { factory = nextFactory; }) },
			sessionManager: { getBranch: vi.fn((): unknown[] => []) },
		};
		for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);

		const component = factory?.({ requestRender: vi.fn() });
		expect(component?.render(160)).toEqual([]);

		ctx.sessionManager.getBranch.mockReturnValue([{ type: "message" }]);
		expect(stripAnsi(component!.render(160)[0]!)).toContain(TOP_CHROME_BRAND);
		expect(component!.render(60)).toHaveLength(3);
	});
});
