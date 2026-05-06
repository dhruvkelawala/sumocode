import type { EmptyChatQuoteNode } from "../cathedral/empty-chat-quote.js";
import type { SplashTree } from "../cathedral/splash-tree.js";
import type { SumoNode } from "../layout/node.js";
import type { ChatPager } from "../widgets/chat-pager.js";

export type RetainedShellPhase = "splash" | "fading-splash" | "active-chat";

export interface RetainedShellTransitionParts {
	readonly root: SumoNode;
	readonly chat: ChatPager;
	readonly splash: SplashTree;
	readonly emptyChatQuote?: EmptyChatQuoteNode;
	readonly scheduleRender?: () => void;
	readonly now?: () => number;
	readonly setTimeout?: (callback: () => void, ms: number) => unknown;
	readonly reducedMotion?: boolean;
}

/**
 * Owns the retained shell's no-messages → active-chat transition.
 *
 * This keeps the product state machine out of the Pi compatibility runtime:
 * empty sessions mount the cathedral splash, while the first rendered message
 * swaps in ChatPager. The empty-chat quote remains allocated for future v2 work
 * but is deliberately unmounted because UX_SPEC §0 says splash owns the empty
 * slot.
 */
export class RetainedShellTransition {
	private static readonly FADE_MS = 80;
	private fadingSince: number | undefined;

	public constructor(private readonly parts: RetainedShellTransitionParts) {}

	public phase(): RetainedShellPhase {
		if (this.fadingSince !== undefined) return "fading-splash";
		return this.parts.chat.hasMessages() ? "active-chat" : "splash";
	}

	public sync(): RetainedShellPhase {
		const { root, chat, splash, emptyChatQuote } = this.parts;
		const desiredPhase = chat.hasMessages() ? "active-chat" : "splash";
		const shouldStartFade = desiredPhase === "active-chat" && !this.parts.reducedMotion && splash.root.parent === root && this.fadingSince === undefined;
		if (shouldStartFade) this.fadingSince = this.now();
		splash.setDimmed(this.fadingSince !== undefined);
		splash.syncVisibility();

		if (emptyChatQuote && emptyChatQuote.parent === root) {
			root.removeChild(emptyChatQuote);
		}

		if (desiredPhase === "active-chat") {
			if (shouldStartFade) {
				this.parts.scheduleRender?.();
				this.parts.setTimeout?.(() => this.parts.scheduleRender?.(), RetainedShellTransition.FADE_MS);
				return "fading-splash";
			}
			if (this.fadingSince !== undefined && this.now() - this.fadingSince < RetainedShellTransition.FADE_MS) {
				return "fading-splash";
			}
			this.fadingSince = undefined;
			splash.setDimmed(false);
			if (splash.root.parent === root) root.removeChild(splash.root);
			if (chat.parent !== root) root.addChild(chat);
			return "active-chat";
		}

		this.fadingSince = undefined;
		splash.setDimmed(false);
		if (chat.parent === root) root.removeChild(chat);
		if (splash.root.parent !== root) root.addChild(splash.root);
		return "splash";
	}

	private now(): number {
		return this.parts.now?.() ?? Date.now();
	}
}
