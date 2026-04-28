import type { EmptyChatQuoteNode } from "../cathedral/empty-chat-quote.js";
import type { SplashTree } from "../cathedral/splash-tree.js";
import type { SumoNode } from "../layout/node.js";
import type { ChatPager } from "../widgets/chat-pager.js";

export type RetainedShellPhase = "splash" | "active-chat";

export interface RetainedShellTransitionParts {
	readonly root: SumoNode;
	readonly chat: ChatPager;
	readonly splash: SplashTree;
	readonly emptyChatQuote?: EmptyChatQuoteNode;
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
	public constructor(private readonly parts: RetainedShellTransitionParts) {}

	public phase(): RetainedShellPhase {
		return this.parts.chat.hasMessages() ? "active-chat" : "splash";
	}

	public sync(): RetainedShellPhase {
		const { root, chat, splash, emptyChatQuote } = this.parts;
		const phase = this.phase();
		splash.syncVisibility();

		if (emptyChatQuote && emptyChatQuote.parent === root) {
			root.removeChild(emptyChatQuote);
		}

		if (phase === "active-chat") {
			if (splash.root.parent === root) root.removeChild(splash.root);
			if (chat.parent !== root) root.addChild(chat);
			return phase;
		}

		if (chat.parent === root) root.removeChild(chat);
		if (splash.root.parent !== root) root.addChild(splash.root);
		return phase;
	}
}
