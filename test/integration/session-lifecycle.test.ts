import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, EditorComponent, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { RegionRegistry } from "../../src/sumo-tui/pi-compat/region-registry.js";
import { DIRECTION_LTR, loadYoga } from "../../src/sumo-tui/layout/yoga.js";
import { ChatPager } from "../../src/sumo-tui/widgets/chat-pager.js";

class TestEditor implements Component {
	public text = "";
	public invalidate(): void {}
	public render(_width: number): string[] {
		return [this.text];
	}
	public setText(text: string): void {
		this.text = text;
	}
	public getText(): string {
		return this.text;
	}
}

function fakeTui(): TUI {
	return { requestRender: vi.fn(), terminal: { columns: 80, rows: 24, setTitle: vi.fn() } } as unknown as TUI;
}

function fakeTheme(): Theme {
	return {} as Theme;
}

function fakeEditorTheme(): EditorTheme {
	return { borderColor: (value: string) => value, selectList: {} } as EditorTheme;
}

function fakeKeybindings(): KeybindingsManager {
	return {} as KeybindingsManager;
}

describe("Phase 4 retained session lifecycle", () => {
	it("boots slots, clears chat on new session, and disposes the Yoga tree", async () => {
		const yoga = await loadYoga();
		const registry = new RegionRegistry({
			yoga,
			tui: fakeTui(),
			theme: fakeTheme(),
			editorTheme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
		});
		const chat = ChatPager.create(yoga, registry.getSlot("chat"));
		const editor = new TestEditor();

		registry.mountHeader(["SUMOCODE"]);
		registry.mountEditor(() => editor as unknown as EditorComponent);
		chat.addMessage("user", "hello");
		chat.addMessage("sumo", "world");
		registry.root.width = 80;
		registry.root.height = 24;
		registry.root.yogaNode.calculateLayout(80, 24, DIRECTION_LTR);

		expect(chat.getRenderedMessages()).toHaveLength(2);
		expect(registry.getMounted("__editor")?.slot).toBe("editor");

		chat.clearMessages();
		editor.setText("");

		expect(chat.getRenderedMessages()).toHaveLength(0);
		expect(editor.getText()).toBe("");

		registry.dispose();
		expect(() => registry.root.markDirty()).toThrow("SumoNode has been disposed");
	});
});
