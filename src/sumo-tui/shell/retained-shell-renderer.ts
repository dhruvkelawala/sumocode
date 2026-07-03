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
 *   ├── retained top-chrome (h: header lines)
 *   ├── blank              (h: 1 when active, h: 0 on splash)
 *   ├── chat-row           (flexGrow: 1, flexDirection: row)
 *   │   └── chat-or-splash (flexGrow: 1)   ← splash when no messages, ChatPager when active
 *   ├── blank              (h: 1)
 *   ├── input-frame        (measured by PiEditorLeaf)
 *   ├── hint-row           (h: 1)
 *   ├── blank              (h: 1)
 *   ├── footer             (h: 1)
 *   └── blank              (h: 1)
 *
 * Composites Pi's own overlay stack on top of the buffer so existing widgets
 * that depend on `tui.showOverlay` (modal selectors, notifications) keep
 * working while permanent chrome is owned by Yoga siblings.
 */

import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { SumoNode } from "../layout/node.js";
import {
	ALIGN_STRETCH,
	DIRECTION_LTR,
	FLEX_DIRECTION_COLUMN,
	FLEX_DIRECTION_ROW,
	JUSTIFY_CENTER,
	type Yoga,
} from "../layout/yoga.js";
import { activeThemeColors } from "../../themes/index.js";
import { withPersistentStyle } from "../render/primitives.js";
import { CellBuffer, type Rect } from "../render/buffer.js";
import { composite, dispatchMouseEvent, type CompositeSelectionPass, type HardwareCursor } from "../render/compositor.js";
import { diffFrames } from "../render/diff.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import type { MouseEvent } from "../input/mouse.js";
import type { ChatPager } from "../widgets/chat-pager.js";
import { PiComponentLeaf } from "../widgets/pi-component-leaf.js";
import { PiEditorLeaf } from "../widgets/pi-editor-leaf.js";
import type { SplashTree } from "../cathedral/splash-tree.js";
import { SIDEBAR_WIDTH, sidebarGutterWidth } from "../../sidebar-placement.js";
import type {
	RetainedShellRendererOptions,
	ShellOverlayEntry,
	ShellOverlayOptions,
	ShellRenderable,
	ShellOverlayHost,
	ShellSidebarPublicationProvider,
	ShellTerminalSessionOwner,
	ShellTopChromeProvider,
	ShellViewport,
} from "./contracts.js";

interface ShellLeafRenderable extends ShellRenderable {
	invalidate(): void;
}

const SPLASH_EDITOR_FRAME_WIDTH = 60;
const SHELL_TOP_CHROME_GAP_ROW = 1;
const SHELL_BLANK_ROW = 1;
const SHELL_HINT_ROW = 1;
const SHELL_FOOTER_GAP_ROW = 1;
const SHELL_FOOTER_ROW = 1;
const SHELL_BOTTOM_SAFE_ROW = 1;

/**
 * Owns the full-screen Yoga layout per issue #161 Slice A.
 *
 * Composition: top-chrome → gap → chat-row → blank → input → hint → footer. Footer
 * is pinned to the last row by the column flex constraint, not by row counting.
 */
export class RetainedShellRenderer {
	public readonly root: SumoNode;
	private readonly yoga: Yoga;
	private readonly terminal: ShellTerminalSessionOwner;
	private readonly dimensions: ShellViewport;
	private readonly overlayHost: ShellOverlayHost | undefined;
	private readonly resolveSidebarPublication: ShellSidebarPublicationProvider;
	private readonly resolveTopChromePublication: ShellTopChromeProvider;
	private readonly selection: CompositeSelectionPass | undefined;
	private readonly paintHardwareCursorAsSoftware: boolean;
	private lastFrame: CellBuffer | undefined;
	private previousFrame: CellBuffer | undefined;
	private readonly headerLeaf: PiComponentLeaf;
	private readonly topChromeGapSpacer: SumoNode;
	private readonly resolvePendingMessages: (() => ShellRenderable) | undefined;
	private readonly editorRow: SumoNode;
	private readonly editorLeftSpacer: SumoNode;
	private readonly editorLeaf: PiEditorLeaf;
	private readonly editorRightSpacer: SumoNode;
	private readonly hintLeaf: PiComponentLeaf;
	private readonly footerLeaf: PiComponentLeaf;
	private readonly chatRow: SumoNode;
	private readonly sidebarGutter: SumoNode;
	private readonly sidebarLeaf: PiComponentLeaf;
	/**
	 * Always-blank 1-row breathing spacer between the chat region and the
	 * above-editor widget slot. Keeps transient activity chrome from crowding
	 * the final chat message.
	 */
	private readonly aboveIndicatorSpacer: SumoNode;
	/**
	 * Always-blank 1-row breathing spacer between the above-editor widget slot
	 * and the editor. Preserves the V2 Bible contract that transient activity
	 * chrome (notably the working indicator) does not crowd the editor frame.
	 */
	private readonly belowIndicatorSpacer: SumoNode;
	/**
	 * 1-row leaf above the editor. Wraps Pi's `widgetContainerAbove` so widgets
	 * registered with `setWidget(... "aboveEditor")` (notably the working
	 * indicator) actually paint inside the owned shell. Renders an empty row
	 * when no widget is mounted (or the widget reports idle).
	 */
	private readonly aboveEditorLeaf: PiComponentLeaf;
	private readonly hasAboveEditorContainer: boolean;
	private readonly footerGapSpacer: SumoNode;
	private readonly bottomSafeSpacer: SumoNode;
	private readonly chat: ChatPager;
	private readonly splash: SplashTree | undefined;
	private readonly resolveActivity: () => boolean;
	private mountedChatChild: "chat" | "splash" | undefined;
	private mountedSidebar = false;
	private inputMountedInSplash: boolean | undefined;
	private disposed = false;

	public constructor(options: RetainedShellRendererOptions) {
		this.yoga = options.yoga;
		this.terminal = options.terminal;
		this.dimensions = options.viewport;
		this.chat = options.chat.pager;
		this.splash = options.splash?.tree;
		this.overlayHost = options.overlayHost;
		this.resolveSidebarPublication = options.sidebar ?? (() => undefined);
		this.resolveTopChromePublication = options.topChrome ?? (() => undefined);
		this.selection = options.selection;
		this.paintHardwareCursorAsSoftware = options.paintHardwareCursorAsSoftware ?? false;
		this.resolveActivity = options.isActive ?? (() => this.chat.hasMessages());

		this.root = new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;

		const headerProxy = new LazyComponentProxy(() => this.resolveTopChromePublication()?.component ?? options.topChromeFallback()?.component ?? EMPTY_COMPONENT);
		const editorProxy = new LazyComponentProxy(options.editor);
		const hintProxy = new LazyComponentProxy(options.belowEditorWidgets);
		const footerProxy = new LazyComponentProxy(options.footer);
		const sidebarProxy = new LazyComponentProxy(() => this.resolveSidebarPublication()?.component ?? EMPTY_COMPONENT);

		// 1) top-chrome
		this.headerLeaf = PiComponentLeaf.create(this.yoga, headerProxy, this.root);

		// 1b) breathing row between title bar and chat/sidebar content.
		// Collapses on splash so the compact 24-row splash keeps its wordmark.
		this.topChromeGapSpacer = new SumoNode(this.yoga.Node.create(), this.root);
		this.topChromeGapSpacer.height = SHELL_TOP_CHROME_GAP_ROW;

		// 2) chat-row (flexGrow: 1)
		this.chatRow = new SumoNode(this.yoga.Node.create(), this.root);
		this.chatRow.flexDirection = FLEX_DIRECTION_ROW;
		this.chatRow.alignItems = ALIGN_STRETCH;
		this.chatRow.flexGrow = 1;
		this.chatRow.flexShrink = 1;

		// Owned-shell owns the sidebar as a real Yoga sibling of ChatPager when the
		// legacy Pi sidebar overlay is present and visible. This reserves the right
		// columns structurally, so chat scroll/diff can never paint through or stale
		// out the sidebar surface.
		this.sidebarGutter = new SumoNode(this.yoga.Node.create());
		this.sidebarGutter.flexShrink = 0;
		this.sidebarLeaf = PiComponentLeaf.create(this.yoga, sidebarProxy);
		this.sidebarLeaf.width = SIDEBAR_WIDTH;
		this.sidebarLeaf.height = "100%";
		this.sidebarLeaf.flexShrink = 0;
		this.syncChatRowChildren(this.dimensions.columns ?? 80, this.dimensions.rows ?? 24);

		// 3) blank breathing row above the activity slot.
		this.aboveIndicatorSpacer = new SumoNode(this.yoga.Node.create(), this.root);
		this.aboveIndicatorSpacer.height = SHELL_BLANK_ROW;

		// 3b) above-editor row — hosts Pi's `widgetContainerAbove` (the slot for
		//     `setWidget(... "aboveEditor")` widgets such as the working indicator).
		//
		//     Pi's `renderWidgetContainer(... leadingSpacer=true)` injects a leading
		//     `Spacer(1)` before the first widget, so `widgetContainerAbove.render(w)`
		//     returns `[<spacer line>, <widget line(s)>…]`. We already have a
		//     dedicated breathing row above this leaf, so Pi's spacer would push the
		//     widget into a clipped row 2. Drop Pi's leading line so the widget
		//     paints into row 1 of the leaf.
		//
		//    Defaults to a static empty 1-row component when the host doesn't
		//    expose a Pi-style above-editor container.
		this.hasAboveEditorContainer = options.aboveEditorWidgets !== undefined;
		const aboveSource: ShellRenderable | undefined = this.hasAboveEditorContainer
			? new LazyComponentProxy(options.aboveEditorWidgets!)
			: undefined;
		const aboveProxy: ShellLeafRenderable = aboveSource
			? {
					render: (w: number) => {
						const raw = aboveSource.render(w);
						// Drop Pi's leading Spacer(1). If nothing remains, no above-editor
						// widget is installed, so collapse to zero rows. If a widget remains
						// but renders blank (the retained working indicator's idle state),
						// still reserve the block height so agent_start/agent_end does not
						// shift the editor. Leading blank provided here; trailing gap is
						// provided by belowIndicatorSpacer (always SHELL_BLANK_ROW).
						const content = raw.length > 1 ? raw.slice(1) : [];
						return content.length > 0 ? ["", ...content] : [];
					},
					invalidate: () => aboveSource.invalidate?.(),
				}
			: { render: (_w: number) => [], invalidate: () => undefined };
		this.aboveEditorLeaf = PiComponentLeaf.create(this.yoga, aboveProxy, this.root);

		// 3c) blank breathing row — always 1 empty row between the above-editor
		//     widget slot and the editor. This is the row that keeps `Working…`
		//     from visually touching the input frame while the agent is busy.
		this.belowIndicatorSpacer = new SumoNode(this.yoga.Node.create(), this.root);
		this.belowIndicatorSpacer.height = SHELL_BLANK_ROW;

		// 3d) pending messages — painted into the lower blank spacer row during composite,
		// NOT a separate Yoga leaf. This avoids vertical layout shift when messages
		// are queued.
		this.resolvePendingMessages = options.pendingMessageWidgets;

		// 4) input slot — wraps Pi's `editorContainer` so the live editor AND
		// Pi-internal selectors (`/resume`, model picker, confirm dialogs) both
		// render through the same Yoga leaf. PiEditorLeaf scans rendered lines
		// for the editor's CURSOR_MARKER; selectors don't emit one and that's
		// the correct behaviour (no editor cursor while a selector is focused).
		// In empty splash mode the row centers the input frame; once chat starts,
		// the editor returns to the full-width active input contract.
		this.editorRow = new SumoNode(this.yoga.Node.create(), this.root);
		this.editorRow.flexDirection = FLEX_DIRECTION_ROW;
		this.editorRow.justifyContent = JUSTIFY_CENTER;
		this.editorLeftSpacer = new SumoNode(this.yoga.Node.create());
		this.editorLeftSpacer.flexGrow = 1;
		this.editorLeftSpacer.flexShrink = 1;
		this.editorLeaf = PiEditorLeaf.create(this.yoga, editorProxy as unknown as CustomEditor);
		this.editorRightSpacer = new SumoNode(this.yoga.Node.create());
		this.editorRightSpacer.flexGrow = 1;
		this.editorRightSpacer.flexShrink = 1;
		this.syncEditorRowChildren(this.dimensions.columns ?? 80);

		// 5) hint row
		this.hintLeaf = PiComponentLeaf.create(this.yoga, hintProxy, this.root);
		this.hintLeaf.height = SHELL_HINT_ROW;

		// 6) breathing row between hint and footer. This preserves the V2 Bible
		// contract from #188: active input must not visually crowd the status footer.
		this.footerGapSpacer = new SumoNode(this.yoga.Node.create(), this.root);
		this.footerGapSpacer.height = SHELL_FOOTER_GAP_ROW;

		// 7) footer
		this.footerLeaf = PiComponentLeaf.create(this.yoga, footerProxy, this.root);
		this.footerLeaf.height = SHELL_FOOTER_ROW;

		// 8) bottom safe row. cmux/Ghostty prompt/cursor affordances are easier to
		// read with a terminal-bottom guard row, and the visual Bible encodes this
		// as the final blank row in active portrait/landscape scenes.
		this.bottomSafeSpacer = new SumoNode(this.yoga.Node.create(), this.root);
		this.bottomSafeSpacer.height = SHELL_BOTTOM_SAFE_ROW;

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
	private syncEditorRowChildren(cols: number): void {
		const centered = this.inputMountedInSplash;
		const frameWidth = centered ? Math.min(cols, SPLASH_EDITOR_FRAME_WIDTH) : cols;
		if (this.editorLeftSpacer.parent === this.editorRow) this.editorRow.removeChild(this.editorLeftSpacer);
		if (this.editorLeaf.parent === this.editorRow) this.editorRow.removeChild(this.editorLeaf);
		if (this.editorRightSpacer.parent === this.editorRow) this.editorRow.removeChild(this.editorRightSpacer);

		this.editorLeaf.width = frameWidth;
		this.editorLeaf.flexShrink = centered ? 0 : 1;
		if (centered && frameWidth < cols) this.editorRow.addChild(this.editorLeftSpacer);
		this.editorRow.addChild(this.editorLeaf);
		if (centered && frameWidth < cols) this.editorRow.addChild(this.editorRightSpacer);
	}

	private syncInputPlacement(): void {
		const centerWithSplash = !!this.splash && !this.resolveActivity();
		if (centerWithSplash === this.inputMountedInSplash) return;

		const movableNodes: SumoNode[] = [
			this.aboveIndicatorSpacer,
			this.aboveEditorLeaf,
			this.belowIndicatorSpacer,
			this.editorRow,
			this.hintLeaf,
			this.footerGapSpacer,
			this.footerLeaf,
			this.bottomSafeSpacer,
		];
		for (const node of movableNodes) {
			if (node.parent) node.parent.removeChild(node);
		}

		if (centerWithSplash && this.splash) {
			if (this.splash.bottomSpacer.parent === this.splash.root) this.splash.root.removeChild(this.splash.bottomSpacer);
			// Splash mode never shows the working indicator (no agent activity yet),
			// so the above-editor leaf stays detached and both indicator spacers are
			// repurposed: belowIndicatorSpacer provides breathing above the editor,
			// aboveIndicatorSpacer provides the gap between editor and hint row.
			// Restore both to SHELL_BLANK_ROW because active-layout may have zeroed one.
			this.aboveIndicatorSpacer.height = SHELL_BLANK_ROW;
			this.belowIndicatorSpacer.height = SHELL_BLANK_ROW;
			this.splash.root.addChild(this.belowIndicatorSpacer);
			this.splash.root.addChild(this.editorRow);
			this.splash.root.addChild(this.aboveIndicatorSpacer);
			this.splash.root.addChild(this.hintLeaf);
			this.splash.root.addChild(this.splash.bottomSpacer);
			this.root.addChild(this.footerGapSpacer);
			this.root.addChild(this.footerLeaf);
			this.root.addChild(this.bottomSafeSpacer);
		} else {
			if (this.splash && this.splash.bottomSpacer.parent !== this.splash.root) this.splash.root.addChild(this.splash.bottomSpacer);
			if (this.hasAboveEditorContainer) this.root.addChild(this.aboveEditorLeaf);
			// Always 1 explicit blank row between the above-editor block and the
			// editor. The aboveProxy provides a leading blank; this spacer provides
			// the trailing gap so the bar / indicator never touches the input frame.
			this.belowIndicatorSpacer.height = SHELL_BLANK_ROW;
			this.root.addChild(this.belowIndicatorSpacer);
			this.root.addChild(this.editorRow);
			this.root.addChild(this.hintLeaf);
			this.root.addChild(this.footerGapSpacer);
			this.root.addChild(this.footerLeaf);
			this.root.addChild(this.bottomSafeSpacer);
		}

		this.inputMountedInSplash = centerWithSplash;
	}

	private syncChatRowChildren(cols: number, rows: number): void {
		const wantSplash = !!this.splash && !this.resolveActivity();
		const desired: "chat" | "splash" = wantSplash ? "splash" : "chat";
		this.topChromeGapSpacer.height = desired === "chat" ? SHELL_TOP_CHROME_GAP_ROW : 0;
		const sidebarVisible = desired === "chat" && this.isSidebarVisible(cols, rows);
		const gutterWidth = sidebarVisible ? sidebarGutterWidth(cols, rows) : 0;
		if (desired === "chat") {
			// ChatPager declares `flexBasis: 0 + flexGrow: 1` in its constructor so
			// Yoga always sizes it from the row's leftover width and stretches it
			// to the row's height. The owned shell only needs to reserve the
			// sidebar's fixed columns; the chat fills whatever remains.
			this.sidebarGutter.width = gutterWidth;
			this.sidebarLeaf.width = SIDEBAR_WIDTH;
		}
		if (desired === this.mountedChatChild && sidebarVisible === this.mountedSidebar) return;

		// Detach whichever nodes are currently attached. Chat/splash state lives on
		// the nodes themselves, so remounting them under the row is cheap and keeps
		// the child ordering deterministic: chat → gutter → sidebar.
		if (this.chat.parent === this.chatRow) this.chatRow.removeChild(this.chat);
		if (this.splash && this.splash.root.parent === this.chatRow) this.chatRow.removeChild(this.splash.root);
		if (this.sidebarGutter.parent === this.chatRow) this.chatRow.removeChild(this.sidebarGutter);
		if (this.sidebarLeaf.parent === this.chatRow) this.chatRow.removeChild(this.sidebarLeaf);

		if (desired === "splash" && this.splash) {
			this.splash.syncVisibility();
			// Splash defaults to flexShrink: 0 on its content leaf so it never gets
			// squished in the chat-only tree. In the owned-shell tree the chat-row
			// shares vertical space with the editor (which grows when /resume or any
			// other selector mounts inside Pi's editorContainer). Allow the splash
			// content to shrink so the selector takes priority and splash clips
			// gracefully instead of overflowing into the input/hint/footer rows.
			this.splash.content.flexShrink = 1;
			this.chatRow.addChild(this.splash.root);
		} else {
			const currentParent = this.chat.parent;
			if (currentParent && currentParent !== this.chatRow) currentParent.removeChild(this.chat);
			this.chat.flexGrow = 1;
			this.chat.flexShrink = 1;
			this.chatRow.addChild(this.chat);
			if (sidebarVisible) {
				this.chatRow.addChild(this.sidebarGutter);
				this.chatRow.addChild(this.sidebarLeaf);
			}
		}
		this.mountedChatChild = desired;
		this.mountedSidebar = sidebarVisible;
		logDiagnostic("owned_shell_chat_row", { mounted: desired, sidebarVisible });
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

		this.syncChatRowChildren(cols, rows);
		this.syncInputPlacement();
		this.syncEditorRowChildren(cols);
		// Re-measure dynamic-height leaves so Yoga grows the editor when
		// autocomplete is shown, and shrinks it back when dismissed. Without this
		// PiComponentLeaf would return its stale cached measure and the autocomplete
		// dropdown would be clipped or invisible.
		this.headerLeaf.markDirty();
		this.aboveEditorLeaf.markDirty();
		this.editorLeaf.markDirty();
		this.hintLeaf.markDirty();
		this.footerLeaf.markDirty();
		this.sidebarLeaf.markDirty();
		this.root.width = cols;
		this.root.height = rows;
		const layoutStart = performance.now();
		this.root.yogaNode.calculateLayout(cols, rows, DIRECTION_LTR);
		const layoutMs = performance.now() - layoutStart;

		const compositeStart = performance.now();
		const frame = new CellBuffer(rows, cols);
		const result = composite(this.root, frame, this.selection ? { selection: this.selection } : {});
		this.paintPendingMessages(frame, cols);
		const overlayCount = this.compositeOverlays(frame, cols, rows);
		const compositeMs = performance.now() - compositeStart;

		// Hide the hardware cursor when an overlay (modal/notification) is visible
		// so the editor's cursor doesn't bleed through the modal's text.
		const cursor: HardwareCursor | null = overlayCount > 0 ? null : result.hardwareCursor;
		if (cursor && this.paintHardwareCursorAsSoftware) this.paintSoftwareCursor(frame, cursor);
		// Owned-shell has independently pinned regions (chat, sidebar, input,
		// footer). Terminal scroll-region optimization moves the whole screen and
		// corrupts those siblings during ChatPager scroll. Use row diffs only.
		const patches = diffFrames(this.previousFrame, frame, { detectScroll: false });
		this.terminal.writeFramePatches(patches, cursor);
		this.previousFrame = frame.clone();
		this.lastFrame = frame;

		logDiagnostic("owned_shell_render", {
			cols,
			rows,
			layoutMs: Math.round(layoutMs * 100) / 100,
			compositeMs: Math.round(compositeMs * 100) / 100,
			patchCount: patches.length,
			overlayCount,
			mountedChild: this.mountedChatChild,
			rects: {
				header: this.nodeRect(this.headerLeaf),
				topChromeGap: this.nodeRect(this.topChromeGapSpacer),
				chatRow: this.nodeRect(this.chatRow),
				chat: this.nodeRect(this.chat),
				sidebarGutter: this.nodeRect(this.sidebarGutter),
				sidebar: this.nodeRect(this.sidebarLeaf),
				inputSpacer: this.nodeRect(this.belowIndicatorSpacer),
				aboveEditorSpacer: this.nodeRect(this.aboveIndicatorSpacer),
				aboveEditor: this.nodeRect(this.aboveEditorLeaf),
				editorRow: this.nodeRect(this.editorRow),
				editor: this.nodeRect(this.editorLeaf),
				hint: this.nodeRect(this.hintLeaf),
				footerGap: this.nodeRect(this.footerGapSpacer),
				footer: this.nodeRect(this.footerLeaf),
				bottomSafe: this.nodeRect(this.bottomSafeSpacer),
			},
			hardwareCursor: cursor ? { row: cursor.row, col: cursor.col } : null,
		});
	}

	private paintSoftwareCursor(frame: CellBuffer, cursor: HardwareCursor): void {
		const { rows, cols } = frame.getDimensions();
		if (cursor.row < 0 || cursor.row >= rows || cursor.col < 0 || cursor.col >= cols) return;
		const cell = frame.getCell(cursor.row, cursor.col);
		frame.setCell(cursor.row, cursor.col, {
			...cell,
			char: cell.char.length > 0 ? cell.char : " ",
			fg: activeThemeColors().background,
			bg: activeThemeColors().accent,
			attrs: { ...cell.attrs, inverse: false },
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

	/**
	 * Paint pending steer/follow-up messages as a Cathedral banner at the
	 * bottom of the chat area. The banner overlays the last N rows of the
	 * chat pager region without shifting the Yoga layout.
	 */
	private paintPendingMessages(frame: CellBuffer, _cols: number): void {
		if (!this.resolvePendingMessages) return;
		try {
			const container = this.resolvePendingMessages();
			const chatWidth = Math.max(1, Math.floor(this.chat.getComputedWidth()));
			const chatLeft = Math.floor(this.chatRow.getComputedLeft() + this.chat.getComputedLeft());
			const rendered = container.render(chatWidth);
			const contentLines = rendered.filter((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim().length > 0);
			if (contentLines.length === 0) return;

			const chatBottom = Math.floor(this.chatRow.getComputedTop() + this.chatRow.getComputedHeight());
			const height = Math.min(contentLines.length, Math.floor(this.chatRow.getComputedHeight()));
			const top = chatBottom - height;
			if (top < 0) return;

			const T = activeThemeColors();
			for (let i = 0; i < height; i += 1) {
				const plain = (contentLines[i] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
				const padded = plain.length < chatWidth ? `${plain}${" ".repeat(chatWidth - plain.length)}` : plain.slice(0, chatWidth);
				frame.paintRow(top + i, withPersistentStyle(padded, T.foregroundDim, T.surfaceLifted), chatLeft, chatWidth);
			}
		} catch {
			// Container may not be ready yet
		}
	}

	private isSidebarVisible(termWidth: number, termHeight: number): boolean {
		const publication = this.resolveSidebarPublication();
		if (!publication) return false;
		try {
			return publication.isVisible(termWidth, termHeight);
		} catch {
			return false;
		}
	}

	private isOverlayVisible(entry: ShellOverlayEntry, termWidth: number, termHeight: number): boolean {
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

	public handleMouseEvent(event: MouseEvent): boolean {
		if (this.disposed) return false;
		const handled = dispatchMouseEvent(this.root, event);
		if (handled) {
			logDiagnostic("owned_shell_mouse_dispatch", {
				type: event.type,
				row: event.row,
				col: event.col,
				scrollDir: event.scrollDir ?? null,
			});
		}
		return handled;
	}

	public getLastFrame(): CellBuffer | undefined {
		return this.lastFrame;
	}

	public getChatRect(): Rect | undefined {
		if (this.mountedChatChild !== "chat") return undefined;
		return {
			top: this.chat.getComputedTop() + this.chatRow.getComputedTop(),
			left: this.chat.getComputedLeft() + this.chatRow.getComputedLeft(),
			width: this.chat.getComputedWidth(),
			height: this.chat.getComputedHeight(),
		};
	}

	private nodeRect(node: SumoNode): { top: number; left: number; width: number; height: number } {
		return {
			top: node.getComputedTop(),
			left: node.getComputedLeft(),
			width: node.getComputedWidth(),
			height: node.getComputedHeight(),
		};
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.headerLeaf.dispose();
		this.topChromeGapSpacer.dispose();
		this.editorLeaf.dispose();
		this.hintLeaf.dispose();
		this.footerLeaf.dispose();
		this.aboveIndicatorSpacer.dispose();
		this.aboveEditorLeaf.dispose();
		this.belowIndicatorSpacer.dispose();
		this.footerGapSpacer.dispose();
		this.bottomSafeSpacer.dispose();
		// Chat + splash are owned by SumoInteractiveRuntime; only detach.
		if (this.chat.parent === this.chatRow) this.chatRow.removeChild(this.chat);
		if (this.splash && this.splash.root.parent === this.chatRow) this.chatRow.removeChild(this.splash.root);
		if (this.sidebarGutter.parent === this.chatRow) this.chatRow.removeChild(this.sidebarGutter);
		if (this.sidebarLeaf.parent === this.chatRow) this.chatRow.removeChild(this.sidebarLeaf);
		this.sidebarGutter.dispose();
		this.sidebarLeaf.dispose();
		// The editor row is created at construction time and reparented into the
		// splash column when the splash is active. When splash.root is detached
		// above, editorRow becomes orphaned and is NOT reached by root.dispose()
		// below. Explicitly dispose it here regardless of parentage (dispose is
		// idempotent, so it's safe to call in both splash and post-splash states).
		this.editorLeftSpacer.dispose();
		this.editorRightSpacer.dispose();
		this.editorRow.dispose();
		this.chatRow.dispose();
		this.root.dispose();
		this.previousFrame = undefined;
	}
}

const EMPTY_COMPONENT: ShellLeafRenderable = {
	invalidate(): void {},
	render(): string[] {
		return [];
	},
};

/**
 * Component proxy that re-resolves its target on every render. Required so
 * the owned-shell follows post-reload references when Pi swaps `customFooter`
 * (and similar) via `setExtensionFooter`/`setExtensionHeader` after
 * `ctx.reload()` / `ctx.newSession()` / `ctx.fork()`. Without this, the leaf
 * would keep calling the disposed component which throws
 * `assertActive: extension ctx is stale`.
 */
class LazyComponentProxy implements ShellLeafRenderable {
	public constructor(private readonly resolver: () => ShellRenderable) {}
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
	options: ShellOverlayOptions | undefined,
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
