import { describe, expect, it, vi } from "vitest";
import {
	SumoInteractiveRuntime,
	filterPiNoiseChildren,
	forceHardwareCursorVisible,
	installPiNoiseFilter,
	isPiNoiseTextComponent,
	shouldForceHardwareCursor,
	shouldHidePiNoise,
	type PiNoiseFilterState,
} from "./sumo-interactive-mode.js";
import { installChatViewportBridge } from "./chat-viewport-controller.js";
import { defaultSplashSnapshot, getSplashContentHeight } from "../cathedral/splash-tree.js";
import { ALTSCREEN_ENTER_SEQUENCE, MOUSE_SGR_ENABLE_SEQUENCE, TerminalSessionOwner } from "../runtime/terminal-controller.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function firstNonBlankRow(lines: readonly string[]): number {
	return lines.findIndex((line) => stripAnsi(line).trim().length > 0);
}

class TextNode {
	public constructor(public text: string) {}
}

class Spacer {}

describe("sumo interactive Pi noise filtering", () => {
	it("matches Pi startup noise Text components after ANSI styling", () => {
		expect(isPiNoiseTextComponent(new TextNode("\x1b[33m[Extension issues]\x1b[0m\nshortcut conflict"))).toBe(true);
		expect(isPiNoiseTextComponent(new TextNode("\x1b[33mWarning: Anthropic subscription auth is active. Third-party harness usage draws from extra usage.\x1b[0m"))).toBe(true);
		expect(isPiNoiseTextComponent(new TextNode("Warning: Wait for the current response to finish before reloading."))).toBe(false);
	});

	it("filters known noise and the spacer Pi appends after it", () => {
		const keep = new TextNode("real chat message");
		const state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false };
		const container = {
			children: [new TextNode("[Extension issues]\nconflict"), new Spacer(), keep],
		};

		expect(filterPiNoiseChildren(container, state)).toBe(2);
		expect(container.children).toEqual([keep]);
		expect(state.removedNodes).toHaveLength(2);
	});

	it("patches chatContainer.addChild so late Anthropic warnings never enter chat", () => {
		const state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false };
		const children: unknown[] = [];
		const upstream = {
			chatContainer: {
				children,
				addChild(component: unknown) {
					children.push(component);
				},
			},
		};
		const keep = new TextNode("real warning");

		expect(installPiNoiseFilter(upstream, state)).toBe(true);
		upstream.chatContainer.addChild(new TextNode("Warning: Anthropic subscription auth is active. Third-party harness usage draws from extra usage."));
		upstream.chatContainer.addChild(new Spacer());
		upstream.chatContainer.addChild(keep);

		expect(children).toEqual([keep]);
		expect(state.removedNodes).toHaveLength(2);
	});

	it("defaults SUMO_TUI_HIDE_PI_NOISE and hardware cursor forcing on, with env opt-outs", () => {
		expect(shouldHidePiNoise({})).toBe(true);
		expect(shouldHidePiNoise({ SUMO_TUI_HIDE_PI_NOISE: "0" })).toBe(false);
		expect(shouldForceHardwareCursor({})).toBe(true);
		expect(shouldForceHardwareCursor({ SUMO_TUI_SHOW_HARDWARE_CURSOR: "false" })).toBe(false);
	});

	it("forces Pi's TUI hardware cursor visible in SumoInteractiveMode", () => {
		const setShowHardwareCursor = vi.fn();
		const upstream = { ui: { setShowHardwareCursor } };

		expect(forceHardwareCursorVisible(upstream)).toBe(true);
		expect(setShowHardwareCursor).toHaveBeenCalledWith(true);
	});

	it("enters altscreen and enables SGR mouse from the retained runtime", async () => {
		const write = vi.fn();
		const runtime = new SumoInteractiveRuntime({ isTTY: true, columns: 100, rows: 30, write });

		await runtime.start();

		const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain(ALTSCREEN_ENTER_SEQUENCE);
		expect(output).toContain(MOUSE_SGR_ENABLE_SEQUENCE);
		runtime.stop();
	});

	it("shares the terminal owner with lifecycle startup without duplicate mode writes", async () => {
		const write = vi.fn();
		const output = { isTTY: true, columns: 100, rows: 30, write };
		const terminal = new TerminalSessionOwner({ output });
		terminal.startRetainedSession();
		const runtime = new SumoInteractiveRuntime(output, terminal);

		await runtime.start();

		const written = write.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(written.match(/\x1b\[\?1049h/g) ?? []).toHaveLength(1);
		expect(written.match(/\x1b\[\?1000h\x1b\[\?1006h/g) ?? []).toHaveLength(1);
		runtime.stop();
	});

	it("renders the retained splash centered in the chat slot until the first message", async () => {
		const runtime = new SumoInteractiveRuntime({ isTTY: false, columns: 100, rows: 30, write: vi.fn() });
		const snapshot = await runtime.start();

		const lines = runtime.renderChatLines(100, 30);
		const expectedTop = Math.floor((30 - getSplashContentHeight(defaultSplashSnapshot(false), 100)) / 2);
		expect(firstNonBlankRow(lines)).toBeGreaterThanOrEqual(expectedTop);
		expect(lines.join("\n")).toContain("38;2;217;119;6");
		expect(stripAnsi(lines.join("\n"))).toContain("Meow meow meow");

		snapshot.chat.addMessage("user", "hello");
		const chatLines = runtime.renderChatLines(100, 30);
		expect(stripAnsi(chatLines.join("\n"))).toContain("USER > hello");
		expect(stripAnsi(chatLines.join("\n"))).not.toContain("Meow meow meow");
		runtime.stop();
	});

	it("caches retained chat frames when upstream re-renders without chat dirtiness", async () => {
		const runtime = new SumoInteractiveRuntime({ isTTY: false, columns: 100, rows: 30, write: vi.fn() });
		await runtime.start();
		const first = runtime.renderChatLines(100, 30);
		const second = runtime.renderChatLines(100, 30);

		expect(second).toEqual(first);
		runtime.stop();
	});

	it("routes Pi chat rendering and wheel input through ChatPager", async () => {
		const inputListeners: ((data: string) => { consume?: boolean; data?: string } | void)[] = [];
		const runtime = new SumoInteractiveRuntime({ isTTY: false, columns: 80, rows: 20, write: vi.fn() });
		await runtime.start();
		const upstream: {
			ui: {
				terminal: { rows: number; columns: number };
				requestRender: ReturnType<typeof vi.fn>;
				addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | void): () => void;
			};
			headerContainer: { render(width: number): string[] };
			pendingMessagesContainer: { render(width: number): string[] };
			statusContainer: { render(width: number): string[] };
			widgetContainerAbove: { render(width: number): string[] };
			editorContainer: { render(width: number): string[] };
			widgetContainerBelow: { render(width: number): string[] };
			footer: { render(width: number): string[] };
			chatContainer: { children: unknown[]; addChild(child: unknown): void; render(width: number): string[]; clear(): void };
			handleEvent: (event: unknown) => unknown;
		} = {
			ui: {
				terminal: { rows: 12, columns: 80 },
				requestRender: vi.fn(),
				addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | void) {
					inputListeners.push(listener);
					return () => undefined;
				},
			},
			headerContainer: { render: (_width: number) => ["header"] },
			pendingMessagesContainer: { render: (_width: number) => [] },
			statusContainer: { render: (_width: number) => [] },
			widgetContainerAbove: { render: (_width: number) => [] },
			editorContainer: { render: (_width: number) => ["editor", "hints"] },
			widgetContainerBelow: { render: (_width: number) => [] },
			footer: { render: (_width: number) => ["footer"] },
			chatContainer: {
				children: [],
				addChild(child: unknown) {
					this.children.push(child);
				},
				render: (_width: number) => ["upstream chat"],
				clear() {
					this.children = [];
				},
			},
			handleEvent: vi.fn(),
		};

		const cleanup = installChatViewportBridge(upstream, runtime);
		for (let index = 0; index < 50; index += 1) {
			await upstream.handleEvent({ type: "message_start", message: { role: "user", content: `message ${index}` } });
		}
		upstream.chatContainer.render(60);
		const before = runtime.getSnapshot()?.chat.scrollBox.scrollOffset ?? 0;

		const result = inputListeners[0]?.("\x1b[<64;10;5M");
		const after = runtime.getSnapshot()?.chat.scrollBox.scrollOffset ?? 0;
		const jumpResult = inputListeners[0]?.("\x1b[b");
		const jumped = runtime.getSnapshot()?.chat.scrollBox.scrollOffset ?? 0;

		expect(result).toEqual({ consume: true });
		expect(after).toBeLessThan(before);
		expect(jumpResult).toEqual({ consume: true });
		expect(jumped).toBe(before);
		expect(upstream.ui.requestRender).toHaveBeenCalledWith(true);
		const rendered = upstream.chatContainer.render(60).join("\n");
		expect(rendered).toContain("USER >");
		expect(rendered).not.toContain("upstream chat");
		cleanup?.();
		runtime.stop();
	});

	it("buffers split SGR mouse sequences so trackpad bytes never reach Pi's editor", async () => {
		const inputListeners: ((data: string) => { consume?: boolean; data?: string } | void)[] = [];
		const runtime = new SumoInteractiveRuntime({ isTTY: false, columns: 80, rows: 20, write: vi.fn() });
		await runtime.start();
		const upstream = {
			ui: {
				terminal: { rows: 12, columns: 80 },
				requestRender: vi.fn(),
				addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | void) {
					inputListeners.push(listener);
					return () => undefined;
				},
			},
			headerContainer: { render: (_width: number) => ["header"] },
			pendingMessagesContainer: { render: (_width: number) => [] },
			statusContainer: { render: (_width: number) => [] },
			widgetContainerAbove: { render: (_width: number) => [] },
			editorContainer: { render: (_width: number) => ["editor", "hints"] },
			widgetContainerBelow: { render: (_width: number) => [] },
			footer: { render: (_width: number) => ["footer"] },
			chatContainer: {
				children: [] as unknown[],
				addChild(child: unknown) {
					this.children.push(child);
				},
				render: (_width: number) => ["upstream chat"],
				clear() {
					this.children = [];
				},
			},
			handleEvent: vi.fn(),
		};

		const cleanup = installChatViewportBridge(upstream, runtime);
		for (let index = 0; index < 50; index += 1) {
			await upstream.handleEvent({ type: "message_start", message: { role: "user", content: `message ${index}` } });
		}
		upstream.chatContainer.render(60);
		const before = runtime.getSnapshot()?.chat.scrollBox.scrollOffset ?? 0;

		// Event coords (row=19, col=43) sit outside the chat region for this test
		// chrome geometry, so we only assert that the bridge fully consumed the
		// split bytes — no leak — independent of scroll motion.
		const firstChunk = inputListeners[0]?.("\x1b[<64;43;19");
		const secondChunk = inputListeners[0]?.("M");
		const after = runtime.getSnapshot()?.chat.scrollBox.scrollOffset ?? 0;

		expect(firstChunk).toEqual({ consume: true });
		expect(secondChunk).toEqual({ consume: true });
		expect(after).toBe(before);
		cleanup?.();
		runtime.stop();
	});

	it("drops orphan mouse fragments that follow a stale partial sequence (long-chat trackpad path)", async () => {
		const inputListeners: ((data: string) => { consume?: boolean; data?: string } | void)[] = [];
		const runtime = new SumoInteractiveRuntime({ isTTY: false, columns: 80, rows: 20, write: vi.fn() });
		await runtime.start();
		const upstream = {
			ui: {
				terminal: { rows: 12, columns: 80 },
				requestRender: vi.fn(),
				addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | void) {
					inputListeners.push(listener);
					return () => undefined;
				},
			},
			headerContainer: { render: (_width: number) => ["header"] },
			pendingMessagesContainer: { render: (_width: number) => [] },
			statusContainer: { render: (_width: number) => [] },
			widgetContainerAbove: { render: (_width: number) => [] },
			editorContainer: { render: (_width: number) => ["editor", "hints"] },
			widgetContainerBelow: { render: (_width: number) => [] },
			footer: { render: (_width: number) => ["footer"] },
			chatContainer: {
				children: [] as unknown[],
				addChild(child: unknown) {
					this.children.push(child);
				},
				render: (_width: number) => ["upstream chat"],
				clear() {
					this.children = [];
				},
			},
			handleEvent: vi.fn(),
		};

		const cleanup = installChatViewportBridge(upstream, runtime);
		for (let index = 0; index < 50; index += 1) {
			await upstream.handleEvent({ type: "message_start", message: { role: "user", content: `message ${index}` } });
		}
		upstream.chatContainer.render(60);

		// Stale partial sequence followed by complete sequences in the same chunk —
		// this is the wheel-spam pattern reported when chat scroll is available.
		const stale = "\x1b[<64;33;19";
		const wheel = "\x1b[<64;33;19M";
		const result = inputListeners[0]?.(stale + wheel + wheel);

		expect(result).toEqual({ consume: true });
		cleanup?.();
		runtime.stop();
	});
});
