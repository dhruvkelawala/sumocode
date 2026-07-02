import type { SplashTree } from "../cathedral/splash-tree.js";
import type { ChatPager } from "../widgets/chat-pager.js";
import type { CompositeSelectionPass } from "../render/compositor.js";
import type { TerminalPatch } from "../runtime/terminal-controller.js";

export interface ShellRenderable {
	render(width: number): string[];
	invalidate?(): void;
}

export interface ShellViewport {
	readonly columns?: number;
	readonly rows?: number;
}

export interface ShellTerminalSessionOwner {
	writeFramePatches(patches: readonly TerminalPatch[], cursor: { row: number; col: number } | null): void;
}

export interface ShellChatSurface {
	readonly pager: ChatPager;
}

export interface ShellSplashSurface {
	readonly tree: SplashTree;
}

export interface ShellTopChromePublication {
	readonly component: ShellRenderable;
}

export interface ShellSidebarPublication {
	readonly component: ShellRenderable;
	readonly isVisible: (cols: number, rows: number) => boolean;
}

export type ShellOverlayAnchor =
	| "center"
	| "top-left"
	| "top-center"
	| "top-right"
	| "left-center"
	| "right-center"
	| "bottom-left"
	| "bottom-center"
	| "bottom-right";

export interface ShellOverlayMargin {
	readonly top?: number;
	readonly right?: number;
	readonly bottom?: number;
	readonly left?: number;
}

export interface ShellOverlayOptions {
	readonly width?: number | string;
	readonly minWidth?: number;
	readonly maxHeight?: number | string;
	readonly margin?: number | ShellOverlayMargin;
	readonly anchor?: ShellOverlayAnchor;
	readonly row?: number | string;
	readonly col?: number | string;
	readonly offsetY?: number;
	readonly offsetX?: number;
	readonly visible?: (cols: number, rows: number) => boolean;
}

export interface ShellOverlayEntry {
	readonly component: ShellRenderable;
	readonly options?: ShellOverlayOptions;
	readonly hidden?: boolean;
	readonly focusOrder?: number;
}

export interface ShellOverlayHost {
	readonly overlayStack?: readonly ShellOverlayEntry[];
	isOverlayVisible?(entry: ShellOverlayEntry): boolean;
}

export type ShellTopChromeProvider = () => ShellTopChromePublication | undefined;
export type ShellEditorProvider = () => ShellRenderable;
export type ShellWidgetProvider = () => ShellRenderable;
export type ShellFooterProvider = () => ShellRenderable;
export type ShellSidebarPublicationProvider = () => ShellSidebarPublication | undefined;
export type ShellSelectionPass = CompositeSelectionPass;

export interface RetainedShellRendererOptions {
	readonly yoga: import("../layout/yoga.js").Yoga;
	readonly chat: ShellChatSurface;
	readonly splash?: ShellSplashSurface;
	readonly editor: ShellEditorProvider;
	readonly topChromeFallback: ShellTopChromeProvider;
	readonly topChrome?: ShellTopChromeProvider;
	readonly belowEditorWidgets: ShellWidgetProvider;
	readonly aboveEditorWidgets?: ShellWidgetProvider;
	readonly pendingMessageWidgets?: ShellWidgetProvider;
	readonly footer: ShellFooterProvider;
	readonly terminal: ShellTerminalSessionOwner;
	readonly viewport: ShellViewport;
	readonly overlayHost?: ShellOverlayHost;
	readonly selection?: ShellSelectionPass;
	readonly sidebar?: ShellSidebarPublicationProvider;
}
