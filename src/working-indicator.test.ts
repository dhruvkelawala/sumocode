import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetThemeRegistryForTests, setActiveTheme } from "./themes/index.js";
import { ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS, ULTRAVIOLET_RUNCAT_FRAMES, ULTRAVIOLET_RUNCAT_INTERVAL_MS } from "./themes/ultraviolet-core.js";
import { CATHEDRAL_TOKENS } from "./tokens.js";
import {
	CATHEDRAL_INDICATOR_FRAMES,
	CATHEDRAL_INDICATOR_INTERVAL_MS,
	buildActiveThemeIndicatorFrames,
	formatSpinnerInspection,
	indicatorFrameAt,
	isRetainedMode,
	renderIndicator,
	shouldInstallWorkingIndicator,
	WorkingIndicatorComponent,
} from "./working-indicator.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, "");

afterEach(() => {
	resetThemeRegistryForTests();
});

describe("indicatorFrameAt", () => {
	it("returns the frame at the given tick when in range", () => {
		const frames = ["a", "b", "c"];

		expect(indicatorFrameAt(0, frames)).toContain("a");
		expect(indicatorFrameAt(1, frames)).toContain("b");
		expect(indicatorFrameAt(2, frames)).toContain("c");
	});

	it("cycles back to the first frame past the end", () => {
		const frames = ["a", "b", "c"];

		expect(indicatorFrameAt(3, frames)).toContain("a");
		expect(indicatorFrameAt(4, frames)).toContain("b");
		expect(indicatorFrameAt(99, frames)).toContain("a");
	});
});

describe("renderIndicator", () => {
	it("uses the SumoCode flower-pulse arc with zero glyph overlap vs Claude Code", () => {
		expect(CATHEDRAL_INDICATOR_FRAMES).toEqual(["◌", "✦", "❖", "✺", "❋", "❉"]);
	});

	it("shares no glyph with Claude Code's reverse-engineered spinner", () => {
		const claudeSpinner = new Set(["·", "✻", "✽", "✶", "✳", "✢"]);
		for (const frame of CATHEDRAL_INDICATOR_FRAMES) {
			expect(claudeSpinner.has(frame), `frame "${frame}" overlaps with Claude Code`).toBe(false);
		}
	});

	it("keeps every frame single-cell so the indicator never jumps", () => {
		const widths = new Set(CATHEDRAL_INDICATOR_FRAMES.map((frame) => stripAnsi(frame).length));
		expect(widths).toEqual(new Set([1]));
	});

	it("uses the temple cadence", () => {
		expect(CATHEDRAL_INDICATOR_INTERVAL_MS).toBe(150);
	});

	it("colorizes the current frame with the Cathedral accent", () => {
		const output = renderIndicator(0, CATHEDRAL_INDICATOR_FRAMES, CATHEDRAL_TOKENS.colors.accent);
		const raw = CATHEDRAL_INDICATOR_FRAMES[0];

		expect(output).toContain(raw);
		expect(output).toMatch(/\u001b\[38;2;\d+;\d+;\d+m/);
		expect(output).toMatch(/\u001b\[0m$/);
	});

	it("ships at least 4 Cathedral frames so the rotation has perceivable rhythm", () => {
		expect(CATHEDRAL_INDICATOR_FRAMES.length).toBeGreaterThanOrEqual(4);
	});

	it("uses a non-palindromic rotation so the animation never reads as stuck", () => {
		// A palindrome cycle (e.g. a,b,c,b,a) makes the spinner stutter because
		// half the loop retraces. Every frame must be unique within the cycle.
		const seen = new Set(CATHEDRAL_INDICATOR_FRAMES);
		expect(seen.size).toBe(CATHEDRAL_INDICATOR_FRAMES.length);
	});
});

describe("isRetainedMode", () => {
	it("matches Pi's truthy SUMO_TUI activation flags", () => {
		for (const value of ["1", "true", "TRUE", "yes", "YES", "on", "ON"]) {
			expect(isRetainedMode({ SUMO_TUI: value })).toBe(true);
		}
	});

	it("treats unset and false-like SUMO_TUI values as classic mode", () => {
		for (const value of [undefined, "", "0", "false", "FALSE", "no", "off"]) {
			expect(isRetainedMode({ SUMO_TUI: value })).toBe(false);
		}
	});
});

describe("shouldInstallWorkingIndicator", () => {
	it("keeps the working row out of portrait 60-column scenes", () => {
		expect(shouldInstallWorkingIndicator(60)).toBe(false);
		expect(shouldInstallWorkingIndicator(79)).toBe(false);
		expect(shouldInstallWorkingIndicator(80)).toBe(true);
		expect(shouldInstallWorkingIndicator(160)).toBe(true);
	});
});

describe("buildActiveThemeIndicatorFrames", () => {
	it("resolves Ultraviolet RunCat only when the capability is enabled", () => {
		setActiveTheme("ultraviolet-core");

		expect(stripAnsi(buildActiveThemeIndicatorFrames({ SUMOCODE_RUNCAT_FONT: "1" })[0]!)).toBe(ULTRAVIOLET_RUNCAT_FRAMES[0]);
		expect(stripAnsi(buildActiveThemeIndicatorFrames({ SUMOCODE_RUNCAT_FONT: "0" })[0]!)).toBe(".");
	});

	it("keeps Cathedral byte-compatible when the RunCat env is enabled", () => {
		setActiveTheme("cathedral");

		expect(buildActiveThemeIndicatorFrames({ SUMOCODE_RUNCAT_FONT: "1" })).toEqual(buildActiveThemeIndicatorFrames({}));
	});
});

describe("WorkingIndicatorComponent", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("renders an empty row when idle", () => {
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui);

		expect(component.render(80)).toEqual([""]);

		component.dispose();
	});

	it("renders a colored frame and label when busy", () => {
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui);

		component.start();
		const [line] = component.render(80);
		expect(line).toBeDefined();
		expect(line!.includes(CATHEDRAL_INDICATOR_FRAMES[0]!)).toBe(true);
		expect(line).toMatch(/Working/);
		expect(tui.requestRender).toHaveBeenCalled();

		component.dispose();
		vi.useRealTimers();
	});

	it("advances the frame on each interval tick while busy", () => {
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui);

		component.start();
		const before = tui.requestRender.mock.calls.length;
		vi.advanceTimersByTime(CATHEDRAL_INDICATOR_INTERVAL_MS * 3);
		expect(tui.requestRender.mock.calls.length).toBeGreaterThan(before);

		component.dispose();
		vi.useRealTimers();
	});

	it("stops cycling and renders empty after stop()", () => {
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui);

		component.start();
		component.stop();
		expect(component.isBusy()).toBe(false);
		expect(component.render(80)).toEqual([""]);

		component.dispose();
		vi.useRealTimers();
	});

	it("re-renders when the active theme changes", () => {
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui);

		tui.requestRender.mockClear();
		setActiveTheme("obsidian");
		expect(tui.requestRender).toHaveBeenCalled();

		component.dispose();
		vi.useRealTimers();
	});

	it("renders Ultraviolet RunCat frames with the enhanced cadence when enabled", () => {
		vi.useFakeTimers();
		setActiveTheme("ultraviolet-core");
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui, { SUMOCODE_RUNCAT_FONT: "1" });

		component.start();
		let line = component.render(160)[0]!;
		expect(line).toContain(ULTRAVIOLET_RUNCAT_FRAMES[0]);
		expect(line).toContain("\u001b[38;2;185;116;255m");
		expect(stripAnsi(line)).toBe(` ${ULTRAVIOLET_RUNCAT_FRAMES[0]} Working…`);
		expect(visibleWidth(stripAnsi(line))).toBe(11);

		tui.requestRender.mockClear();
		vi.advanceTimersByTime(ULTRAVIOLET_RUNCAT_INTERVAL_MS - 1);
		expect(tui.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		line = component.render(160)[0]!;
		expect(line).toContain(ULTRAVIOLET_RUNCAT_FRAMES[1]);

		component.dispose();
		vi.useRealTimers();
	});

	it("falls Ultraviolet back to the orbital cadence when the capability is disabled", () => {
		vi.useFakeTimers();
		setActiveTheme("ultraviolet-core");
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui, { SUMOCODE_RUNCAT_FONT: "0" });

		component.start();
		expect(stripAnsi(component.render(160)[0]!)).toBe(" . Working…");
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		component.dispose();
		vi.useRealTimers();
	});

	it("restarts the active timer with each theme's cadence when switching away from and back to RunCat", () => {
		vi.useFakeTimers();
		setActiveTheme("ultraviolet-core");
		const tui = { requestRender: vi.fn() };
		const component = new WorkingIndicatorComponent(tui, { SUMOCODE_RUNCAT_FONT: "1" });

		component.start();
		expect(stripAnsi(component.render(160)[0]!)).toContain(ULTRAVIOLET_RUNCAT_FRAMES[0]);
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(ULTRAVIOLET_RUNCAT_INTERVAL_MS - 1);
		expect(tui.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		setActiveTheme("cathedral");
		expect(stripAnsi(component.render(160)[0]!)).toContain(CATHEDRAL_INDICATOR_FRAMES[1]);
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(CATHEDRAL_INDICATOR_INTERVAL_MS - 1);
		expect(tui.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		setActiveTheme("ultraviolet-core");
		expect(stripAnsi(component.render(160)[0]!)).toContain(ULTRAVIOLET_RUNCAT_FRAMES[2]);
		tui.requestRender.mockClear();
		vi.advanceTimersByTime(ULTRAVIOLET_RUNCAT_INTERVAL_MS - 1);
		expect(tui.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		component.dispose();
		vi.useRealTimers();
	});
});

describe("formatSpinnerInspection", () => {
	it("prints a numbered, colored row per frame plus the interval", () => {
		const report = formatSpinnerInspection(
			CATHEDRAL_INDICATOR_FRAMES,
			CATHEDRAL_TOKENS.colors.accent,
			CATHEDRAL_INDICATOR_INTERVAL_MS,
		);
		const lines = report.split("\n");
		const plain = stripAnsi(report);

		expect(plain).toContain(`${CATHEDRAL_INDICATOR_FRAMES.length} frames`);
		expect(plain).toContain(`${CATHEDRAL_INDICATOR_INTERVAL_MS}ms`);
		for (let i = 0; i < CATHEDRAL_INDICATOR_FRAMES.length; i++) {
			const frame = CATHEDRAL_INDICATOR_FRAMES[i]!;
			expect(
				lines.some((line) => stripAnsi(line).includes(`${i + 1}`) && line.includes(frame)),
				`expected a numbered row for frame ${i + 1} (${frame})`,
			).toBe(true);
		}
	});
});
