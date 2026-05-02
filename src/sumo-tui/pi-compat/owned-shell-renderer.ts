/*
 * MIT License
 *
 * Copyright (c) Dhruv Kelawala and SumoCode contributors.
 *
 * POC: Yoga-flex outer chrome (issue #195 / #161 Slice A).
 *
 * Owns the full-screen Yoga tree per #161:
 *
 *   column root
 *   ├── top-chrome     (h: 1)
 *   ├── chat-row       (flexGrow: 1, flexDirection: row)
 *   │   ├── chat-pager (flexGrow: 1)
 *   │   ├── gutter     (w: 2)
 *   │   └── sidebar    (flexBasis: 30)   [POC: deferred]
 *   ├── blank          (h: 1)
 *   ├── input-frame    (measured)
 *   ├── hint-row       (h: 1)
 *   └── footer         (h: 1)
 *
 * The renderer wraps Pi's existing components as Yoga leaves and replaces
 * Pi's TUI rendering pass via the existing patches/diff/composite pipeline
 * already used by SumoInteractiveRuntime for the chat viewport.
 */

import type { Component, EditorComponent } from "@mariozechner/pi-tui";
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

export interface OwnedShellRendererTerminal {
	readonly columns?: number;
	readonly rows?: number;
}

export interface OwnedShellRendererOptions {
	readonly yoga: Yoga;
	readonly chat: ChatPager;
	readonly editor: CustomEditor | EditorComponent;
	readonly headerContainer: Component;
	readonly widgetContainerBelow: Component;
	readonly footer: Component;
	readonly terminal: TerminalSessionOwner;
	readonly dimensions: OwnedShellRendererTerminal;
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
	private previousFrame: CellBuffer | undefined;
	private readonly headerLeaf: PiComponentLeaf;
	private readonly editorLeaf: PiEditorLeaf;
	private readonly hintLeaf: PiComponentLeaf;
	private readonly footerLeaf: PiComponentLeaf;
	private readonly chatRow: SumoNode;
	private readonly blankSpacer: SumoNode;
	private readonly chat: ChatPager;
	private disposed = false;

	public constructor(options: OwnedShellRendererOptions) {
		this.yoga = options.yoga;
		this.terminal = options.terminal;
		this.dimensions = options.dimensions;
		this.chat = options.chat;

		this.root = new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;

		// 1) top-chrome
		this.headerLeaf = PiComponentLeaf.create(this.yoga, options.headerContainer, this.root);

		// 2) chat-row (flexGrow: 1)
		this.chatRow = new SumoNode(this.yoga.Node.create(), this.root);
		this.chatRow.flexDirection = FLEX_DIRECTION_ROW;
		this.chatRow.flexGrow = 1;
		this.chatRow.flexShrink = 1;
		this.attachChatToRow();

		// 3) blank breathing row above input
		this.blankSpacer = new SumoNode(this.yoga.Node.create(), this.root);
		this.blankSpacer.height = SHELL_BLANK_ROW;

		// 4) input frame (measured by PiEditorLeaf)
		this.editorLeaf = PiEditorLeaf.create(this.yoga, options.editor as CustomEditor, this.root);

		// 5) hint row
		this.hintLeaf = PiComponentLeaf.create(this.yoga, options.widgetContainerBelow, this.root);
		this.hintLeaf.height = SHELL_HINT_ROW;

		// 6) footer (pinned to last row by flex column)
		this.footerLeaf = PiComponentLeaf.create(this.yoga, options.footer, this.root);
		this.footerLeaf.height = SHELL_FOOTER_ROW;

		logDiagnostic("owned_shell_constructed", {
			cols: this.dimensions.columns ?? null,
			rows: this.dimensions.rows ?? null,
		});
	}

	private attachChatToRow(): void {
		// ChatPager is itself a SumoNode (extends with flexGrow=1). Reparent into chat-row.
		const currentParent = this.chat.parent;
		if (currentParent && currentParent !== this.chatRow) currentParent.removeChild(this.chat);
		if (this.chat.parent !== this.chatRow) this.chatRow.addChild(this.chat);
		this.chat.flexGrow = 1;
		this.chat.flexShrink = 1;
	}

	/**
	 * Single render pass:
	 *   1. Reparent chat (idempotent — handles late mount).
	 *   2. Yoga layout for the full screen.
	 *   3. Composite cells.
	 *   4. Diff against previous frame.
	 *   5. Write patches via TerminalSessionOwner (synchronized output).
	 */
	public render(): void {
		if (this.disposed) return;
		const cols = Math.max(1, Math.floor(this.dimensions.columns ?? 80));
		const rows = Math.max(1, Math.floor(this.dimensions.rows ?? 24));

		this.attachChatToRow();
		this.root.width = cols;
		this.root.height = rows;
		const layoutStart = performance.now();
		this.root.yogaNode.calculateLayout(cols, rows, DIRECTION_LTR);
		const layoutMs = performance.now() - layoutStart;

		const compositeStart = performance.now();
		const frame = new CellBuffer(rows, cols);
		const result = composite(this.root, frame);
		const compositeMs = performance.now() - compositeStart;

		const cursor: HardwareCursor | null = result.hardwareCursor;
		const patches = diffFrames(this.previousFrame, frame);
		this.terminal.writeFramePatches(patches, cursor);
		this.previousFrame = frame.clone();

		logDiagnostic("owned_shell_render", {
			cols,
			rows,
			layoutMs: Math.round(layoutMs * 100) / 100,
			compositeMs: Math.round(compositeMs * 100) / 100,
			patchCount: patches.length,
			hardwareCursor: cursor ? { row: cursor.row, col: cursor.col } : null,
		});
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
		// Chat is owned by SumoInteractiveRuntime; only detach.
		if (this.chat.parent === this.chatRow) this.chatRow.removeChild(this.chat);
		this.chatRow.dispose();
		this.root.dispose();
		this.previousFrame = undefined;
	}
}

const OWNED_SHELL_ENV_FLAG = "SUMOCODE_OWNED_SHELL";

export function ownedShellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[OWNED_SHELL_ENV_FLAG];
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
