/*
 * MIT License
 *
 * Copyright (c) Dhruv Kelawala and SumoCode contributors.
 *
 * Owned-shell renderer (issues #195 / #161 Slice A).
 *
 * Owns the full-screen Yoga tree per #161:
 *
 *   column root
 *   ├── top-chrome     (h: header lines)
 *   ├── chat-row       (flexGrow: 1, flexDirection: row)
 *   │   └── chat-or-splash (flexGrow: 1)   ← splash when no messages, ChatPager when active
 *   ├── blank          (h: 1)
 *   ├── input-frame    (measured by PiEditorLeaf)
 *   ├── hint-row       (h: 1)
 *   └── footer         (h: 1)
 *
 * Composites Pi's own overlay stack on top of the buffer so existing widgets
 * that depend on `tui.showOverlay` (sidebar, modal selectors, notifications)
 * keep working without changes.
 */

import type { Component, OverlayOptions } from "@mariozechner/pi-tui";
import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { SumoNode } from "../layout/node.js";
import {
	DIRECTION_LTR,
	FLEX_DIRECTION_COLUMN,
	FLEX_DIRECTION_ROW,
	type Yoga,
} from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite, type HardwareCursor } from "../render/compositor.js";
import { diffFrames } from "../render/diff.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import type { TerminalSessionOwner } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { PiComponentLeaf } from "../widgets/pi-component-leaf.js";
import { PiEditorLeaf } from "../widgets/pi-editor-leaf.js";
import type { SplashTree } from "../cathedral/splash-tree.js";

export interface OwnedShellRendererTerminal {
	readonly columns?: number;
	readonly rows?: number;
}

interface OverlayEntry {
	readonly component: Component;
	readonly options?: OverlayOptions;
	readonly hidden?: boolean;
	readonly focusOrder?: number;
}

interface PiOverlayHost {
	readonly overlayStack?: readonly OverlayEntry[];
	isOverlayVisible?(entry: OverlayEntry): boolean;
}

export interface OwnedShellRendererOptions {
	readonly yoga: Yoga;
	readonly chat: ChatPager;
	readonly splash?: SplashTree;
	/**
	 * Lazy resolver for Pi's `editorContainer` (NOT the bare `CustomEditor`).
	 * Pi swaps the container's children between the live editor and
	 * Pi-internal selectors (`/resume`, model picker, theme picker, confirm
	 * dialogs, text input). Resolving lazily lets the owned-shell follow
	 * post-reload references when Pi reinstalls the extension UI on
	 * `ctx.reload()` / `ctx.newSession()` / `ctx.fork()`.
	 */
	readonly editorContainer: () => Component;
	readonly headerContainer: () => Component;
	readonly widgetContainerBelow: () => Component;
	/** Resolves to the currently mounted footer (custom extension footer or Pi built-in). */
	readonly footer: () => Component;
	readonly terminal: TerminalSessionOwner;
	readonly dimensions: OwnedShellRendererTerminal;
	/** Pi TUI host that owns the overlay stack (modal/sidebar/notifications). */
	readonly overlayHost?: PiOverlayHost;
}

const SHELL_BLANK_ROW = 1;
const SHELL_HINT_ROW = 1;
const SHELL_FOOTER_ROW = 1;

/**
 * Owns the full-screen Yoga layout per issue #161 Slice A.
 *
 * Composition: top-chrome → chat-row → blank → input → hint → footer. Footer
 * is pinned to the last row by the column flex constraint, not by row counting.
 */
export class OwnedShellRenderer {
	public readonly root: SumoNode;
	private readonly yoga: Yoga;
	private readonly terminal: TerminalSessionOwner;
	private readonly dimensions: OwnedShellRendererTerminal;
	private readonly overlayHost: PiOverlayHost | undefined;
	private previousFrame: CellBuffer | undefined;
	private readonly headerLeaf: PiComponentLeaf;
	private readonly editorLeaf: PiEditorLeaf;
	private readonly hintLeaf: PiComponentLeaf;
	private readonly footerLeaf: PiComponentLeaf;
	private readonly chatRow: SumoNode;
	private readonly blankSpacer: SumoNode;
	private readonly chat: ChatPager;
	private readonly splash: SplashTree | undefined;
	private mountedChatChild: "chat" | "splash" | undefined;
	private disposed = false;

	public constructor(options: OwnedShellRendererOptions) {
		this.yoga = options.yoga;
		this.terminal = options.terminal;
		this.dimensions = options.dimensions;
		this.chat = options.chat;
		this.splash = options.splash;
		this.overlayHost = options.overlayHost;

		this.root = new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;

		const headerProxy = new LazyComponentProxy(options.headerContainer);
		const editorProxy = new LazyComponentProxy(options.editorContainer);
		const hintProxy = new LazyComponentProxy(options.widgetContainerBelow);
		const footerProxy = new LazyComponentProxy(options.footer);

		// 1) top-chrome
		this.headerLeaf = PiComponentLeaf.create(this.yoga, headerProxy, this.root);

		// 2) chat-row (flexGrow: 1)
		this.chatRow = new SumoNode(this.yoga.Node.create(), this.root);
		this.chatRow.flexDirection = FLEX_DIRECTION_ROW;
		this.chatRow.flexGrow = 1;
		this.chatRow.flexShrink = 1;
		this.syncChatRowChild();

		// 3) blank breathing row above input
		this.blankSpacer = new SumoNode(this.yoga.Node.create(), this.root);
		this.blankSpacer.height = SHELL_BLANK_ROW;

		// 4) input slot — wraps Pi's `editorContainer` so the live editor AND
		// Pi-internal selectors (`/resume`, model picker, confirm dialogs) both
		// render through the same Yoga leaf. PiEditorLeaf scans rendered lines
		// for the editor's CURSOR_MARKER; selectors don't emit one and that's
		// the correct behaviour (no editor cursor while a selector is focused).
		this.editorLeaf = PiEditorLeaf.create(this.yoga, editorProxy as unknown as CustomEditor, this.root);

		// 5) hint row
		this.hintLeaf = PiComponentLeaf.create(this.yoga, hintProxy, this.root);
		this.hintLeaf.height = SHELL_HINT_ROW;

		// 6) footer (pinned to last row by flex column)
		this.footerLeaf = PiComponentLeaf.create(this.yoga, footerProxy, this.root);
		this.footerLeaf.height = SHELL_FOOTER_ROW;

		logDiagnostic("owned_shell_constructed", {
			cols: this.dimensions.columns ?? null,
			rows: this.dimensions.rows ?? null,
			hasSplash: this.splash !== undefined,
			hasOverlayHost: this.overlayHost !== undefined,
		});
	}

	/**
	 * Splash sits in the chat-row when ChatPager has no messages, otherwise the
	 * ChatPager occupies the slot. Mirrors `RetainedShellTransition.sync()` but
	 * runs inside the owned shell's chat-row instead of the runtime's chat-only
	 * root tree.
	 */
	private syncChatRowChild(): void {
		const wantSplash = !!this.splash && !this.chat.hasMessages();
		const desired: "chat" | "splash" = wantSplash ? "splash" : "chat";
		if (desired === this.mountedChatChild) return;

		// Detach whichever node is currently attached.
		if (this.chat.parent === this.chatRow) this.chatRow.removeChild(this.chat);
		if (this.splash && this.splash.root.parent === this.chatRow) this.chatRow.removeChild(this.splash.root);

		if (desired === "splash" && this.splash) {
			this.splash.syncVisibility();
			// Splash defaults to flexShrink: 0 on its content leaf so it never gets
			// squished in the chat-only tree. In the owned-shell tree the chat-row
			// shares vertical space with the editor (which grows when /resume or any
			// other selector mounts inside Pi's editorContainer). Allow the splash
			// content to shrink so the selector takes priority and splash clips
			// gracefully instead of overflowing into the input/hint/footer rows.
			this.splash.content.flexShrink = 1;
			if (this.splash.root.parent !== this.chatRow) this.chatRow.addChild(this.splash.root);
		} else {
			// chat: detach from any other parent, then mount under chat-row.
			const currentParent = this.chat.parent;
			if (currentParent && currentParent !== this.chatRow) currentParent.removeChild(this.chat);
			if (this.chat.parent !== this.chatRow) this.chatRow.addChild(this.chat);
			this.chat.flexGrow = 1;
			this.chat.flexShrink = 1;
		}
		this.mountedChatChild = desired;
		logDiagnostic("owned_shell_chat_row", { mounted: desired });
	}

	/**
	 * Single render pass:
	 *   1. Sync chat/splash mount.
	 *   2. Mark all measure-leaves dirty so Yoga re-measures editor/header/hint/footer
	 *      (necessary for autocomplete dropdown growth and dynamic header content).
	 *   3. Yoga layout for the full screen.
	 *   4. Composite cells into a CellBuffer.
	 *   5. Composite Pi's overlay stack (sidebar, modals, notifications) on top.
	 *   6. Diff against previous frame.
	 *   7. Write patches via TerminalSessionOwner (synchronized output).
	 */
	public render(): void {
		if (this.disposed) return;
		const cols = Math.max(1, Math.floor(this.dimensions.columns ?? 80));
		const rows = Math.max(1, Math.floor(this.dimensions.rows ?? 24));

		this.syncChatRowChild();
		// Re-measure dynamic-height leaves so Yoga grows the editor when
		// autocomplete is shown, and shrinks it back when dismissed. Without this
		// PiComponentLeaf would return its stale cached measure and the autocomplete
		// dropdown would be clipped or invisible.
		this.headerLeaf.markDirty();
		this.editorLeaf.markDirty();
		this.hintLeaf.markDirty();
		this.footerLeaf.markDirty();
		this.root.width = cols;
		this.root.height = rows;
		const layoutStart = performance.now();
		this.root.yogaNode.calculateLayout(cols, rows, DIRECTION_LTR);
		const layoutMs = performance.now() - layoutStart;

		const compositeStart = performance.now();
		const frame = new CellBuffer(rows, cols);
		const result = composite(this.root, frame);
		const overlayCount = this.compositeOverlays(frame, cols, rows);
		const compositeMs = performance.now() - compositeStart;

		// Hide the hardware cursor when an overlay (modal/notification) is visible
		// so the editor's cursor doesn't bleed through the modal's text.
		const cursor: HardwareCursor | null = overlayCount > 0 ? null : result.hardwareCursor;
		const patches = diffFrames(this.previousFrame, frame);
		this.terminal.writeFramePatches(patches, cursor);
		this.previousFrame = frame.clone();

		logDiagnostic("owned_shell_render", {
			cols,
			rows,
			layoutMs: Math.round(layoutMs * 100) / 100,
			compositeMs: Math.round(compositeMs * 100) / 100,
			patchCount: patches.length,
			overlayCount,
			mountedChild: this.mountedChatChild,
			hardwareCursor: cursor ? { row: cursor.row, col: cursor.col } : null,
		});
	}

	/**
	 * Mirror of Pi's `TUI.compositeOverlays` against our CellBuffer.
	 *
	 * Pi composes overlays into rendered string lines inside `doRender`, which
	 * we've replaced. To keep `tui.showOverlay`-based widgets (Cathedral
	 * sidebar, Pi extension modal selectors, NotificationCenter toasts) working
	 * without forcing a full migration to RegionRegistry, walk the overlay
	 * stack and paint each visible overlay into the cell buffer.
	 */
	private compositeOverlays(frame: CellBuffer, termWidth: number, termHeight: number): number {
		const stack = this.overlayHost?.overlayStack;
		if (!stack || stack.length === 0) return 0;
		const visibleEntries = stack
			.filter((entry) => this.isOverlayVisible(entry, termWidth, termHeight))
			.slice()
			.sort((left, right) => (left.focusOrder ?? 0) - (right.focusOrder ?? 0));
		if (visibleEntries.length === 0) return 0;

		for (const entry of visibleEntries) {
			const layoutZero = resolveOverlayLayout(entry.options, 0, termWidth, termHeight);
			let overlayLines = entry.component.render(layoutZero.width);
			if (layoutZero.maxHeight !== undefined && overlayLines.length > layoutZero.maxHeight) {
				overlayLines = overlayLines.slice(0, layoutZero.maxHeight);
			}
			const layout = resolveOverlayLayout(entry.options, overlayLines.length, termWidth, termHeight);
			for (let row = 0; row < overlayLines.length; row += 1) {
				const targetRow = layout.row + row;
				if (targetRow < 0 || targetRow >= termHeight) continue;
				frame.paintRow(targetRow, overlayLines[row] ?? "", layout.col, layout.width);
			}
		}
		return visibleEntries.length;
	}

	private isOverlayVisible(entry: OverlayEntry, termWidth: number, termHeight: number): boolean {
		if (entry.hidden === true) return false;
		const visibleFn = (entry.options as { visible?: (cols: number, rows: number) => boolean } | undefined)?.visible;
		if (visibleFn) {
			try {
				return visibleFn(termWidth, termHeight);
			} catch {
				return true;
			}
		}
		// If the upstream host exposes its own visibility resolver, defer to it.
		if (this.overlayHost?.isOverlayVisible) {
			try {
				return this.overlayHost.isOverlayVisible(entry);
			} catch {
				return true;
			}
		}
		return true;
	}

	public invalidatePreviousFrame(): void {
		this.previousFrame = undefined;
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.headerLeaf.dispose();
		this.editorLeaf.dispose();
		this.hintLeaf.dispose();
		this.footerLeaf.dispose();
		this.blankSpacer.dispose();
		// Chat + splash are owned by SumoInteractiveRuntime; only detach.
		if (this.chat.parent === this.chatRow) this.chatRow.removeChild(this.chat);
		if (this.splash && this.splash.root.parent === this.chatRow) this.chatRow.removeChild(this.splash.root);
		this.chatRow.dispose();
		this.root.dispose();
		this.previousFrame = undefined;
	}
}

/**
 * Component proxy that re-resolves its target on every render. Required so
 * the owned-shell follows post-reload references when Pi swaps `customFooter`
 * (and similar) via `setExtensionFooter`/`setExtensionHeader` after
 * `ctx.reload()` / `ctx.newSession()` / `ctx.fork()`. Without this, the leaf
 * would keep calling the disposed component which throws
 * `assertActive: extension ctx is stale`.
 */
class LazyComponentProxy implements Component {
	public constructor(private readonly resolver: () => Component) {}
	public invalidate(): void {
		try {
			this.resolver().invalidate?.();
		} catch {
			// Disposed component - fresh resolver next render.
		}
	}
	public render(width: number): string[] {
		try {
			return this.resolver().render(width);
		} catch (error) {
			logDiagnostic("owned_shell_proxy_render_error", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}
}

interface ResolvedOverlayLayout {
	width: number;
	row: number;
	col: number;
	maxHeight: number | undefined;
}

function parseSizeValue(value: number | string | undefined, reference: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) return Math.floor((reference * Number.parseFloat(match[1])) / 100);
	return undefined;
}

function resolveAnchorRow(anchor: string, height: number, availHeight: number, marginTop: number): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		default:
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

function resolveAnchorCol(anchor: string, width: number, availWidth: number, marginLeft: number): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		default:
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

/**
 * TS port of Pi's `TUI.resolveOverlayLayout`. Kept locally to avoid reaching
 * into Pi internals; reviewed against pi-tui 0.70.x.
 */
function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): ResolvedOverlayLayout {
	const opt = options ?? {};
	const margin = typeof opt.margin === "number"
		? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
		: opt.margin ?? {};
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);

	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

	let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	if (opt.minWidth !== undefined) width = Math.max(width, opt.minWidth);
	width = Math.max(1, Math.min(width, availWidth));

	let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
	if (maxHeight !== undefined) maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

	let row: number;
	let col: number;
	const anchor = opt.anchor ?? "center";
	if (opt.row !== undefined) {
		row = typeof opt.row === "number" ? opt.row : (parseSizeValue(opt.row, availHeight) ?? resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop));
	} else {
		row = resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
	}
	if (opt.col !== undefined) {
		col = typeof opt.col === "number" ? opt.col : (parseSizeValue(opt.col, availWidth) ?? resolveAnchorCol(anchor, width, availWidth, marginLeft));
	} else {
		col = resolveAnchorCol(anchor, width, availWidth, marginLeft);
	}
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

	return { width, row, col, maxHeight };
}

const OWNED_SHELL_ENV_FLAG = "SUMOCODE_OWNED_SHELL";

/**
 * Owned-shell mode is the default daily-drive renderer. Set
 * `SUMOCODE_OWNED_SHELL=0` to fall back to the hybrid Pi+SumoTUI render path
 * for diff bisection or recovery.
 */
export function ownedShellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[OWNED_SHELL_ENV_FLAG];
	if (value === undefined) return true;
	const normalized = value.trim().toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}
