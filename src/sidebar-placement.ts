import type { Component, OverlayHandle, OverlayOptions } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { surfaceLine } from "./sumo-tui/cathedral/ansi.js";

/**
 * Threshold below which the sidebar hides itself. Per DESIGN.md §8
 * (Responsive), the wide layout is ≥ 120 cols: chat ~70 cols + 1 gutter +
 * 49 sidebar fits comfortably. Below this we collapse to chat-only and let
 * sidebar info come through `/sumo:memory` etc.
 */
export const SIDEBAR_MIN_TERMINAL_WIDTH = 120;
/** Render width for the sidebar overlay (DESIGN.md §5 — cols 112..160 in the wide layout). */
export const SIDEBAR_WIDTH = 49;

export type SidebarAnchor = "right-center" | "top-right" | "bottom-right";

/**
 * Pick a sidebar anchor responsive to terminal aspect ratio. Override always
 * wins so per-machine `~/.sumocode/local-config.json` can pin a value.
 */
export function chooseSidebarAnchor(
	termWidth: number,
	termHeight: number,
	override?: SidebarAnchor,
): SidebarAnchor {
	if (override) return override;
	if (termHeight > termWidth * 1.4) return "top-right";
	return "right-center";
}

const STATIC_SIDEBAR_GUTTER = 1;
const STATIC_SIDEBAR_DOCK_MARKER = Symbol("sumocode.staticSidebarDock");

type MutableTuiRoot = {
	children: Component[];
	requestRender(): void;
};

export interface SidebarOverlayHost {
	requestRender(force?: boolean): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
}

function padToWidth(line: string, width: number): string {
	const truncated = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
	const padding = Math.max(0, width - visibleWidth(truncated));
	return `${truncated}${" ".repeat(padding)}`;
}

function renderComponents(components: readonly Component[], width: number): string[] {
	return components.flatMap((component) => component.render(width));
}

/**
 * Static two-column dock used as a guarded workaround for Pi 0.70.x not
 * exposing a public side-panel API. It renders chat/pending/status at a
 * reduced left-column width and appends the sidebar in reserved right columns.
 *
 * This remains as a legacy adapter at the sidebar placement seam. The active
 * adapter is `installNonCapturingSidebarOverlay` because the dock participates
 * in Pi's vertical flow and can stretch/bounce the chat layout.
 */
export class StaticSidebarDock implements Component {
	readonly [STATIC_SIDEBAR_DOCK_MARKER] = true;

	constructor(
		private readonly mainComponents: readonly Component[],
		private readonly sidebarComponent: Component,
		private readonly shouldShowSidebar: () => boolean,
	) {}

	invalidate(): void {
		for (const component of [...this.mainComponents, this.sidebarComponent]) {
			component.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (width < SIDEBAR_MIN_TERMINAL_WIDTH || !this.shouldShowSidebar()) {
			return renderComponents(this.mainComponents, width);
		}

		const mainWidth = Math.max(1, width - SIDEBAR_WIDTH - STATIC_SIDEBAR_GUTTER);
		const mainLines = renderComponents(this.mainComponents, mainWidth);
		const sidebarLines = this.sidebarComponent.render(SIDEBAR_WIDTH);
		// The dock is part of Pi's vertical root flow above the editor/footer. Its
		// height must be dictated by the main column (header + retained chat +
		// status), not by sidebar content. If the sidebar is taller, growing the
		// dock pushes the input/footer down and makes the whole layout bounce during
		// chat scroll/full redraw. Treat the sidebar as clipped to the main column.
		const rowCount = mainLines.length;
		const lines: string[] = [];

		// Pre-build a surface-bg-painted blank sidebar row so rows where the
		// sidebar has no content still cover the right 49 cols with the cathedral
		// surface (#241D17). Without this, cells past the last sidebar line fall
		// back to terminal-default bg — visible as black bands when the chat
		// content underneath is taller than the sidebar (e.g., long tool outputs).
		// surfaceLine pads to width and wraps in cathedral surface bg + fg ANSI.
		const blankSidebarRow = surfaceLine("", SIDEBAR_WIDTH);

		for (let i = 0; i < rowCount; i++) {
			const left = padToWidth(mainLines[i] ?? "", mainWidth);
			const right = i < sidebarLines.length
				? padToWidth(sidebarLines[i]!, SIDEBAR_WIDTH)
				: blankSidebarRow;
			lines.push(`${left}${" ".repeat(STATIC_SIDEBAR_GUTTER)}${right}`);
		}

		return lines;
	}
}

function isStaticSidebarDock(component: Component): component is StaticSidebarDock {
	return (component as Partial<Record<typeof STATIC_SIDEBAR_DOCK_MARKER, boolean>>)[STATIC_SIDEBAR_DOCK_MARKER] === true;
}

/**
 * Guarded root-container surgery. Pi currently gives extensions no public API
 * for static side panels, but `TUI` is a public `Container` and exposes its
 * children array. We only mutate the expected root shape and return a restore
 * callback so reload/shutdown can put Pi's tree back exactly as it was.
 *
 * The dock wraps header + chat + pending + status (everything above the
 * editor) so that the splash, which lives in the header, also respects the
 * reserved sidebar column when the sidebar becomes visible.
 */
export function dockStaticSidebar(
	tui: MutableTuiRoot,
	sidebarComponent: Component,
	shouldShowSidebar: () => boolean,
): (() => void) | undefined {
	if (tui.children.some(isStaticSidebarDock)) return undefined;
	if (tui.children.length < 5) return undefined;

	const [header, chat, pending, status, ...rest] = tui.children;
	if (!header || !chat || !pending || !status || rest.length === 0) return undefined;

	const dock = new StaticSidebarDock([header, chat, pending, status], sidebarComponent, shouldShowSidebar);
	const original = [...tui.children];
	tui.children.splice(0, 4, dock);
	tui.requestRender();

	return () => {
		const dockIndex = tui.children.indexOf(dock);
		if (dockIndex !== -1) {
			tui.children.splice(dockIndex, 1, ...original.slice(0, 4));
		}
	};
}

export function installNonCapturingSidebarOverlay(
	tui: SidebarOverlayHost,
	sidebarComponent: Component,
	shouldShowSidebar: () => boolean,
): { hide(): void } {
	// Keep the sidebar out of Pi's normal vertical line flow. The previous
	// StaticSidebarDock wrapped header/chat/status and made sidebar rows part of
	// the scrollback snapshot; with long chats, Pi's diff/scroll optimizations
	// could smear or duplicate sidebar rows. A non-capturing overlay is
	// screen-relative, so chat can scroll independently while the shell stays
	// pinned.
	const overlayOptions: OverlayOptions = {
		width: SIDEBAR_WIDTH,
		anchor: "top-right",
		margin: { top: 1, right: 0, bottom: 4, left: 0 },
		maxHeight: "90%",
		nonCapturing: true,
		visible: (termWidth) => termWidth >= SIDEBAR_MIN_TERMINAL_WIDTH && shouldShowSidebar(),
	};
	const overlay = tui.showOverlay(sidebarComponent, overlayOptions);
	tui.requestRender(true);
	return overlay;
}
