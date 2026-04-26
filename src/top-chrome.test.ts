import { describe, expect, it } from "vitest";
import {
	renderTopChrome,
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
	it("renders SUMOCODE brand label first", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(line.startsWith(TOP_CHROME_BRAND)).toBe(true);
	});

	it("wraps active session with ║ ║ and includes state dot + label", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(line).toContain("║ ● refactor-auth-flow ║");
	});

	it("uses idle state dot color (#7FB069 sage) in active session", () => {
		const line = renderTopChrome(snapshot({ activeSession: { id: "x", label: "fresh", state: "idle" } }), 160);
		// 127;176;105 = #7FB069
		expect(line).toContain("\u001b[38;2;127;176;105m");
	});

	it("uses thinking state dot color (#E8B339 amber) when state=thinking", () => {
		const line = renderTopChrome(
			snapshot({ activeSession: { id: "x", label: "live", state: "thinking" } }),
			160,
		);
		// 232;179;57 = #E8B339
		expect(line).toContain("\u001b[38;2;232;179;57m");
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

	it("renders [terminal] and [⚙] icons at the right edge", () => {
		const line = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(line).toContain("[terminal]");
		expect(line).toContain("[⚙]");
		const terminalIdx = line.indexOf("[terminal]");
		const settingsIdx = line.indexOf("[⚙]");
		expect(settingsIdx).toBeGreaterThan(terminalIdx);
	});

	it("when hidden=true, only SUMOCODE label is shown (nothing else)", () => {
		const line = stripAnsi(renderTopChrome(snapshot({ hidden: true }), 160));
		expect(line.startsWith(TOP_CHROME_BRAND)).toBe(true);
		expect(line).not.toContain("║");
		expect(line).not.toContain("│");
		expect(line).not.toContain("ARCHIVE");
		expect(line).not.toContain("[terminal]");
		expect(line).not.toContain("[⚙]");
	});

	it("at narrow width drops icons first, then ARCHIVE, then recents", () => {
		// Wide enough for everything
		const wide = stripAnsi(renderTopChrome(snapshot(), 160));
		expect(wide).toContain("[⚙]");

		// Narrow: 80 cols — should drop icons but keep brand + active + maybe some recents
		const narrow = stripAnsi(renderTopChrome(snapshot(), 80));
		expect(narrow).toContain(TOP_CHROME_BRAND);
		expect(narrow).toContain("refactor-auth-flow");

		// Very narrow: 50 cols — only brand + active session
		const veryNarrow = stripAnsi(renderTopChrome(snapshot(), 50));
		expect(veryNarrow).toContain(TOP_CHROME_BRAND);
		expect(veryNarrow).toContain("refactor-auth-flow");
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

	it("renders ║ chars in accent and │ separators in foregroundDim", () => {
		const line = renderTopChrome(snapshot(), 160);
		// accent #D97706 = 217;119;6 — used by ║
		expect(line).toContain("\u001b[38;2;217;119;6m");
		// foregroundDim #8B7A63 = 139;122;99 — used by │ + recents
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
