import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { SIDEBAR_MIN_TERMINAL_WIDTH, SIDEBAR_WIDTH, type SidebarSubTab } from "../../sidebar.js";
import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, FLEX_DIRECTION_ROW, MEASURE_MODE_EXACTLY, type MeasureMode, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { cathedralBackdropCell } from "./theme-bridge.js";

export type SidebarLayoutMode = "dock" | "overlay" | "hidden";

export interface SidebarSessionMarker {
	readonly name: string;
	readonly branch?: string;
	readonly active?: boolean;
}

export interface SidebarLayoutSnapshot {
	readonly terminalWidth: number;
	readonly terminalHeight: number;
	readonly sessionHasMessages: boolean;
	readonly dockMinWidth?: number;
	readonly sidebarWidth?: number;
	readonly activeSubTab?: SidebarSubTab;
	readonly sessions?: readonly SidebarSessionMarker[];
}

export interface SidebarTree {
	readonly root: SumoNode;
	readonly chat: SumoNode;
	readonly backdrop: SidebarBackdropNode;
	readonly sidebar: SumoNode;
	readonly chrome: SidebarChromeNode;
	mode: SidebarLayoutMode;
	sync(snapshot: SidebarLayoutSnapshot): SidebarLayoutMode;
}

function finiteDimension(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function hexToAnsiFg(hexColor: string): string {
	const hex = hexColor.replace("#", "");
	const red = Number.parseInt(hex.slice(0, 2), 16);
	const green = Number.parseInt(hex.slice(2, 4), 16);
	const blue = Number.parseInt(hex.slice(4, 6), 16);
	return `\x1b[38;2;${red};${green};${blue}m`;
}

function color(text: string, hexColor: string): string {
	return `${hexToAnsiFg(hexColor)}${text}\x1b[0m`;
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}

function sessionLabel(session: SidebarSessionMarker): string {
	return session.branch ? `${session.name} (${session.branch})` : session.name;
}

function snapshotSessions(snapshot: SidebarLayoutSnapshot): readonly SidebarSessionMarker[] {
	return snapshot.sessions?.length ? snapshot.sessions : [{ name: "sumocode", branch: "main", active: true }];
}

export function resolveSidebarLayoutMode(snapshot: SidebarLayoutSnapshot): SidebarLayoutMode {
	if (!snapshot.sessionHasMessages) return "hidden";
	return snapshot.terminalWidth >= (snapshot.dockMinWidth ?? SIDEBAR_MIN_TERMINAL_WIDTH) ? "dock" : "overlay";
}

export class SidebarBackdropNode extends SumoNode {
	private visible = false;

	public constructor(yogaNode: YogaNode, parent?: SumoNode) {
		super(yogaNode, parent);
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		if (!this.visible) return;
		buffer.paint(rect, cathedralBackdropCell());
	}
}

export class SidebarChromeNode extends SumoNode {
	private snapshot: SidebarLayoutSnapshot;

	public constructor(yogaNode: YogaNode, parent: SumoNode | undefined, snapshot: SidebarLayoutSnapshot) {
		super(yogaNode, parent);
		this.snapshot = snapshot;
		this.flexDirection = FLEX_DIRECTION_COLUMN;
		this.setMeasureFunc((width, widthMode, _height, _heightMode) => this.measure(width, widthMode));
	}

	public sync(snapshot: SidebarLayoutSnapshot): void {
		this.snapshot = snapshot;
		this.markDirty();
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		const lines = this.lines(rect.width);
		for (let row = 0; row < Math.min(rect.height, lines.length); row += 1) {
			buffer.paintRow(rect.top + row, lines[row] ?? "", rect.left, rect.width);
		}
	}

	private measure(width: number, widthMode: MeasureMode): { width: number; height: number } {
		const resolvedWidth = widthMode === MEASURE_MODE_EXACTLY ? Math.max(1, Math.floor(width)) : SIDEBAR_WIDTH;
		return { width: resolvedWidth, height: this.lines(resolvedWidth).length };
	}

	private lines(width: number): string[] {
		const activeTab = this.snapshot.activeSubTab ?? "CONTEXT";
		const lines = [
			"",
			`  ${color("REGISTRY", CATHEDRAL_TOKENS.colors.accent)}`,
			`  ${color("v 1.0.0", CATHEDRAL_TOKENS.colors.foregroundDim)}`,
			"",
		];
		for (const [index, session] of snapshotSessions(this.snapshot).entries()) {
			const isActive = session.active ?? index === 0;
			const marker = isActive ? color("◆", CATHEDRAL_TOKENS.colors.accent) : color("▢", CATHEDRAL_TOKENS.colors.foregroundDim);
			const label = color(sessionLabel(session), isActive ? CATHEDRAL_TOKENS.colors.foreground : CATHEDRAL_TOKENS.colors.foregroundDim);
			lines.push(`  ${marker} ${label}`);
		}
		lines.push("");
		for (const tab of ["CONTEXT", "MEMORY"] as const) {
			const isActive = tab === activeTab;
			const marker = isActive ? color("◆", CATHEDRAL_TOKENS.colors.accent) : color("▢", CATHEDRAL_TOKENS.colors.foregroundDim);
			const label = isActive ? bold(color(tab, CATHEDRAL_TOKENS.colors.accent)) : color(tab, CATHEDRAL_TOKENS.colors.foregroundDim);
			lines.push(`  ${marker} ${label}`);
		}
		return lines.map((line) => line.padEnd(width, " "));
	}
}

/**
 * Responsive cathedral sidebar host.
 *
 * Wide terminals dock the sidebar as a fixed 49-column sibling after chat.
 * Narrow terminals let chat keep the full width and place sidebar above it as
 * an absolute right overlay with a dim backdrop. Empty splash state hides both
 * sidebar and backdrop (EC-17.6).
 */
export function createSidebarTree(yoga: Yoga, parent: SumoNode | undefined, snapshot: SidebarLayoutSnapshot): SidebarTree {
	const root = new SumoNode(yoga.Node.create(), parent);
	root.flexDirection = FLEX_DIRECTION_ROW;
	root.flexGrow = 1;
	root.flexShrink = 1;

	const chat = new SumoNode(yoga.Node.create(), root);
	chat.flexGrow = 1;
	chat.flexShrink = 1;

	const backdrop = new SidebarBackdropNode(yoga.Node.create(), root);
	backdrop.position = "absolute";
	backdrop.top = 0;
	backdrop.left = 0;
	backdrop.right = 0;
	backdrop.bottom = 0;
	backdrop.zIndex = 100;

	const sidebar = new SumoNode(yoga.Node.create(), root);
	sidebar.flexDirection = FLEX_DIRECTION_COLUMN;
	sidebar.flexShrink = 0;
	sidebar.zIndex = 101;
	const chrome = new SidebarChromeNode(yoga.Node.create(), sidebar, snapshot);

	const tree: SidebarTree = {
		root,
		chat,
		backdrop,
		sidebar,
		chrome,
		mode: "hidden",
		sync(next: SidebarLayoutSnapshot): SidebarLayoutMode {
			const mode = resolveSidebarLayoutMode(next);
			const width = Math.min(next.sidebarWidth ?? SIDEBAR_WIDTH, finiteDimension(next.terminalWidth, SIDEBAR_WIDTH));
			this.mode = mode;
			chrome.sync(next);
			backdrop.setVisible(mode === "overlay");
			if (mode === "hidden") {
				sidebar.position = "relative";
				sidebar.width = 0;
				sidebar.height = 0;
				return mode;
			}
			if (mode === "dock") {
				sidebar.position = "relative";
				sidebar.width = width;
				sidebar.height = "100%";
				return mode;
			}
			sidebar.position = "absolute";
			sidebar.top = 0;
			sidebar.right = 0;
			sidebar.bottom = 0;
			sidebar.width = width;
			sidebar.height = finiteDimension(next.terminalHeight, 24);
			return mode;
		},
	};
	tree.sync(snapshot);
	return tree;
}
