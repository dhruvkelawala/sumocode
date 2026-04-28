import { describe, expect, it, vi } from "vitest";
import { SumoInteractiveRuntime } from "../../src/sumo-tui/pi-compat/sumo-interactive-mode.js";
import { installChatViewportBridge } from "../../src/sumo-tui/pi-compat/chat-viewport-controller.js";

describe("runtime ChatPager scroll bridge", () => {
	it("moves ChatPager scroll offset after an SGR mouse wheel event", async () => {
		const inputListeners: ((data: string) => { consume?: boolean; data?: string } | void)[] = [];
		const runtime = new SumoInteractiveRuntime({ isTTY: false, columns: 100, rows: 24, write: vi.fn() });
		await runtime.start();

		const upstream = {
			ui: {
				terminal: { rows: 14, columns: 100 },
				requestRender: vi.fn(),
				addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | void) {
					inputListeners.push(listener);
					return () => undefined;
				},
			},
			headerContainer: { render: () => ["SUMOCODE"] },
			pendingMessagesContainer: { render: () => [] },
			statusContainer: { render: () => [] },
			widgetContainerAbove: { render: () => [] },
			editorContainer: { render: () => ["> "] },
			widgetContainerBelow: { render: () => [] },
			footer: { render: () => ["READY"] },
			chatContainer: {
				children: [] as unknown[],
				addChild(component: unknown) {
					this.children.push(component);
				},
				render: () => ["upstream full chat"],
				clear() {
					this.children = [];
				},
			},
			handleEvent: vi.fn(),
		};

		const cleanup = installChatViewportBridge(upstream, runtime);
		for (let index = 0; index < 50; index += 1) {
			await upstream.handleEvent({ type: "message_start", message: { role: "user", content: `fake message ${index}` } });
		}

		upstream.chatContainer.render(80);
		const before = runtime.getSnapshot()?.chat.scrollBox.scrollOffset ?? 0;
		const inputResult = inputListeners[0]?.("\x1b[<64;8;4M");
		const after = runtime.getSnapshot()?.chat.scrollBox.scrollOffset ?? 0;

		expect(before).toBeGreaterThan(0);
		expect(after).toBeLessThan(before);
		expect(inputResult).toEqual({ consume: true });
		expect(upstream.chatContainer.render(80).join("\n")).not.toContain("upstream full chat");

		cleanup?.();
		runtime.stop();
	});
});
