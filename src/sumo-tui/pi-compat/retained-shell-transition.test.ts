import { describe, expect, it, vi } from "vitest";
import { EmptyChatQuoteNode } from "../cathedral/empty-chat-quote.js";
import { createSplashTree, defaultSplashSnapshot } from "../cathedral/splash-tree.js";
import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { RetainedShellTransition } from "./retained-shell-transition.js";

describe("RetainedShellTransition", () => {
	it("mounts splash for empty sessions and fades before chat after the first message", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		const chat = ChatPager.create(yoga);
		const splash = createSplashTree(yoga, undefined, () => defaultSplashSnapshot(chat.hasMessages()));
		const emptyQuote = new EmptyChatQuoteNode(yoga.Node.create(), () => ({ sidebarVisible: true, isSplash: false, userMessageCount: 0 }));
		root.addChild(emptyQuote);
		let now = 0;
		const scheduleRender = vi.fn();
		const setTimeoutSpy = vi.fn();
		const transition = new RetainedShellTransition({ root, chat, splash, emptyChatQuote: emptyQuote, now: () => now, scheduleRender, setTimeout: setTimeoutSpy });

		expect(transition.sync()).toBe("splash");
		expect(splash.root.parent).toBe(root);
		expect(chat.parent).toBeUndefined();
		expect(emptyQuote.parent).toBeUndefined();

		chat.addMessage("user", "hello");

		expect(transition.sync()).toBe("fading-splash");
		expect(splash.root.parent).toBe(root);
		expect(chat.parent).toBeUndefined();
		expect(scheduleRender).toHaveBeenCalledOnce();
		expect(setTimeoutSpy).toHaveBeenCalledOnce();

		now = 80;
		expect(transition.sync()).toBe("active-chat");
		expect(chat.parent).toBe(root);
		expect(splash.root.parent).toBeUndefined();

		root.dispose();
		chat.dispose();
		splash.root.dispose();
		emptyQuote.dispose();
	});

	it("bypasses the fade when reduced motion is enabled", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		const chat = ChatPager.create(yoga);
		const splash = createSplashTree(yoga, undefined, () => defaultSplashSnapshot(chat.hasMessages()));
		const transition = new RetainedShellTransition({ root, chat, splash, reducedMotion: true });

		expect(transition.sync()).toBe("splash");
		chat.addMessage("user", "hello");
		expect(transition.sync()).toBe("active-chat");
		expect(chat.parent).toBe(root);
		expect(splash.root.parent).toBeUndefined();

		root.dispose();
		chat.dispose();
		splash.root.dispose();
	});
});
