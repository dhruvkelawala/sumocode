import { describe, expect, it, vi } from "vitest";
import {
	SIDEBAR_MIN_TERMINAL_WIDTH,
	SIDEBAR_WIDTH,
	StaticSidebarDock,
	chooseSidebarAnchor,
	dockStaticSidebar,
	installNonCapturingSidebarOverlay,
} from "./sidebar-placement.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

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

describe("sidebar placement", () => {
	it("keeps the legacy portrait anchor helper deterministic", () => {
		expect(chooseSidebarAnchor(80, 140)).toBe("top-right");
		expect(chooseSidebarAnchor(140, 80)).toBe("right-center");
		expect(chooseSidebarAnchor(140, 80, "bottom-right")).toBe("bottom-right");
	});

	it("renders the legacy dock with clipped sidebar height", () => {
		const left = component(["chat row"]);
		const right = component(["SIDE 1", "SIDE 2", "SIDE 3"]);
		const dock = new StaticSidebarDock([left.node], right.node, () => true);

		const lines = dock.render(160).map(stripAnsi);

		expect(left.renderCalls).toEqual([160 - SIDEBAR_WIDTH - 1]);
		expect(right.renderCalls).toEqual([SIDEBAR_WIDTH]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("chat row");
		expect(lines[0]).toContain("SIDE 1");
		expect(lines[0]).not.toContain("SIDE 2");
	});

	it("hides the legacy dock below the wide-layout threshold or before messages", () => {
		const left = component(["main"]);
		const right = component(["side"]);

		expect(new StaticSidebarDock([left.node], right.node, () => false).render(160).map(stripAnsi)).toEqual(["main"]);
		expect(new StaticSidebarDock([left.node], right.node, () => true).render(SIDEBAR_MIN_TERMINAL_WIDTH - 1).map(stripAnsi)).toEqual(["main"]);
	});

	it("wraps and restores Pi root containers for the legacy dock adapter", () => {
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
		expect(tui.requestRender).toHaveBeenCalledTimes(1);

		restore?.();

		expect(tui.children).toEqual([header, chat, pending, status, editor]);
	});

	it("installs the active non-capturing overlay adapter", () => {
		const sidebar = component(["side"]).node;
		const hide = vi.fn();
		const overlayHandle = { hide, setHidden: vi.fn(), isHidden: vi.fn(() => false), focus: vi.fn(), unfocus: vi.fn(), isFocused: vi.fn(() => false) };
		const showOverlay = vi.fn((_component, _options) => overlayHandle);
		const tui = { requestRender: vi.fn(), showOverlay };

		const overlay = installNonCapturingSidebarOverlay(tui, sidebar, () => true);

		expect(overlay.hide).toBe(hide);
		expect(showOverlay).toHaveBeenCalledWith(sidebar, expect.objectContaining({
			width: SIDEBAR_WIDTH,
			anchor: "top-right",
			nonCapturing: true,
		}));
		const options = showOverlay.mock.calls[0]![1];
		expect(options.visible?.(SIDEBAR_MIN_TERMINAL_WIDTH, 24)).toBe(true);
		expect(options.visible?.(SIDEBAR_MIN_TERMINAL_WIDTH - 1, 24)).toBe(false);
		expect(options.visible?.(60, 100)).toBe(false);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});
});
