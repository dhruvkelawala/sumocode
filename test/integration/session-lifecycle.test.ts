import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
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
	// SAFETY: fake supplies the requestRender/terminal surface the widgets read.
	return { requestRender: vi.fn(), terminal: { columns: 80, rows: 24, setTitle: vi.fn() } } as never;
}

function fakeTheme(): Theme {
	// SAFETY: the theme surface is only read for token lookups in these tests.
	return {} as never;
}

function fakeEditorTheme(): EditorTheme {
	// SAFETY: the theme's color functions are identity mappers for these tests.
	return { borderColor: (value: string) => value, selectList: {} } as never;
}

function fakeKeybindings(): KeybindingsManager {
	// SAFETY: no keybinding lookups run in these tests.
	return {} as never;
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
		// SAFETY: TestEditor implements the editor surface mountEditor expects.
		registry.mountEditor(() => editor as never);
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
