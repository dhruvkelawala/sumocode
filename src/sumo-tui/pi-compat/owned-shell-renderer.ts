import type { Component } from "@earendil-works/pi-tui";
import type { SplashTree } from "../cathedral/splash-tree.js";
import type { ChatPager } from "../widgets/chat-pager.js";
import type {
	RetainedShellRendererOptions,
	ShellOverlayHost,
	ShellSelectionPass,
	ShellSidebarPublication,
	ShellTerminalSessionOwner,
	ShellTopChromePublication,
	ShellViewport,
} from "../shell/contracts.js";
import { RetainedShellRenderer } from "../shell/retained-shell-renderer.js";
import type { Yoga } from "../layout/yoga.js";

export type OwnedShellRendererTerminal = ShellViewport;
export type SidebarPublication = ShellSidebarPublication;
export type TopChromePublication = ShellTopChromePublication;

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
	/** Retained top chrome published by `installTopChrome`; falls back to Pi's header container during tests/startup. */
	readonly topChromePublication?: () => TopChromePublication | undefined;
	readonly widgetContainerBelow: () => Component;
	/**
	 * Lazy resolver for Pi's `widgetContainerAbove` (the slot that hosts
	 * extension widgets registered with `setWidget(..., { placement: "aboveEditor" })`,
	 * including the SumoCode working indicator). Optional for backward
	 * compatibility — owned-shell tests and host environments that don't expose
	 * a Pi-style `widgetContainerAbove` get a static blank single-row leaf.
	 */
	readonly widgetContainerAbove?: () => Component;
	/** Resolves to Pi's pending-messages container (queued steer/follow-up messages). */
	readonly pendingMessagesContainer?: () => Component;
	/** Resolves to the currently mounted footer (custom extension footer or Pi built-in). */
	readonly footer: () => Component;
	readonly terminal: ShellTerminalSessionOwner;
	readonly dimensions: OwnedShellRendererTerminal;
	/** Pi TUI host that owns the overlay stack (modal/sidebar/notifications). */
	readonly overlayHost?: ShellOverlayHost;
	/**
	 * Selection compositor. Owned-shell paints the selection highlight on top
	 * of the composited cell buffer and exposes the latest frame so the
	 * SelectionController can hit-test against the same cells the user sees.
	 * Without this, mouse drag-to-select never reaches selection in owned-shell
	 * mode because the chat frame is no longer rendered through Pi's pipeline.
	 */
	readonly selection?: ShellSelectionPass;
	/**
	 * Lazy resolver for the runtime-published sidebar component. Owned-shell
	 * mounts the sidebar as a Yoga sibling of the chat region instead of
	 * compositing it from Pi's overlay stack. Returning `undefined` hides the
	 * sidebar and reclaims the columns for chat.
	 */
	readonly sidebarPublication?: () => SidebarPublication | undefined;
}

export class OwnedShellRenderer extends RetainedShellRenderer {
	public constructor(options: OwnedShellRendererOptions) {
		super(toRetainedShellOptions(options));
	}
}

export function toRetainedShellOptions(options: OwnedShellRendererOptions): RetainedShellRendererOptions {
	return {
		yoga: options.yoga,
		chat: { pager: options.chat },
		splash: options.splash ? { tree: options.splash } : undefined,
		editor: options.editorContainer,
		topChromeFallback: () => ({ component: options.headerContainer() }),
		topChrome: options.topChromePublication,
		belowEditorWidgets: options.widgetContainerBelow,
		aboveEditorWidgets: options.widgetContainerAbove,
		pendingMessageWidgets: options.pendingMessagesContainer,
		footer: options.footer,
		terminal: options.terminal,
		viewport: options.dimensions,
		overlayHost: options.overlayHost,
		selection: options.selection,
		sidebar: options.sidebarPublication,
	};
}

/**
 * Owned-shell mode is the daily-drive renderer. The old hybrid Pi+SumoTUI
 * outer-chrome path is no longer runtime-selectable; use `sumocode --no-sumo-tui`
 * for emergency recovery into plain Pi.
 */
export function ownedShellEnabled(): boolean {
	return true;
}
