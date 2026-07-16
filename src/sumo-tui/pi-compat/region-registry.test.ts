import type { KeybindingsManager, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DIRECTION_LTR, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { ExtensionStatusPublication, RegionRegistry } from "./region-registry.js";

class TestComponent implements Component {
	public readonly dispose = vi.fn();
	public constructor(private readonly rows: readonly string[] = ["component"]) {}
	public invalidate(): void {}
	public render(_width: number): string[] {
		return [...this.rows];
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

function fakeFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => undefined,
	};
}

async function makeRegistry(): Promise<RegionRegistry> {
	const yoga = await loadYoga();
	return new RegionRegistry({
		yoga,
		tui: fakeTui(),
		theme: fakeTheme(),
		editorTheme: fakeEditorTheme(),
		keybindings: fakeKeybindings(),
		footerData: fakeFooterData(),
	});
}

describe("RegionRegistry", () => {
	it("mounts and unmounts each Pi extension UI slot", async () => {
		const registry = await makeRegistry();

		registry.mountHeader(new TestComponent());
		registry.mountFooter(new TestComponent());
		registry.mountEditor(() => new TestComponent(["editor"]) as unknown as EditorComponent);
		registry.mountWidget("above", new TestComponent(["above"]), { placement: "aboveEditor" });
		registry.mountWidget("below", new TestComponent(["below"]), { placement: "belowEditor" });
		registry.mountWidget("default", new TestComponent(["default"]), { placement: "default" });

		expect(registry.getMounted("__header")?.slot).toBe("header");
		expect(registry.getMounted("__footer")?.slot).toBe("footer");
		expect(registry.getMounted("__editor")?.slot).toBe("editor");
		expect(registry.getMounted("above")?.slot).toBe("aboveEditor");
		expect(registry.getMounted("below")?.slot).toBe("belowEditor");
		expect(registry.getMounted("default")?.slot).toBe("widgets-default");

		registry.unmount("above");
		expect(registry.getMounted("above")).toBeUndefined();
		registry.dispose();
	});

	it("replacing an existing mount disposes the old component and node", async () => {
		const registry = await makeRegistry();
		const first = new TestComponent(["first"]);
		const second = new TestComponent(["second"]);

		registry.mountHeader(first);
		const oldNode = registry.getMounted("__header")?.node;
		registry.mountHeader(second);

		expect(first.dispose).toHaveBeenCalledTimes(1);
		expect(registry.getMounted("__header")?.component).toBe(second);
		expect(() => oldNode?.markDirty()).toThrow("SumoNode has been disposed");
		registry.dispose();
	});

	it("wraps string[] content as a static text leaf", async () => {
		const registry = await makeRegistry();
		registry.mountHeader(["alpha", "beta"]);
		registry.root.width = 12;
		registry.root.height = 6;
		registry.root.yogaNode.calculateLayout(12, 6, DIRECTION_LTR);

		const frame = new CellBuffer(6, 12);
		composite(registry.root, frame);

		expect(frame.toPlainRow(0)).toBe("alpha       ");
		expect(frame.toPlainRow(1)).toBe("beta        ");
		registry.dispose();
	});

	it("mounts a retained ChatPager into the chat slot", async () => {
		const registry = await makeRegistry();
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		chat.addMessage("user", "hello retained chat");

		registry.mountChat(chat);
		registry.root.width = 40;
		registry.root.height = 8;
		registry.root.yogaNode.calculateLayout(40, 8, DIRECTION_LTR);
		const frame = new CellBuffer(8, 40);
		composite(registry.root, frame);

		expect(registry.getSlot("chat").children).toContain(chat);
		expect(frame.toPlainRow(0)).toContain("╭ USER");
		expect(frame.toPlainRow(1)).toContain("hello retained chat");
		registry.dispose();
	});

	it("publishes mounted slot components as backend-neutral renderables", async () => {
		const registry = await makeRegistry();
		registry.mountWidget("above-a", ["first"], { placement: "aboveEditor" });
		registry.mountWidget("above-b", ["second"], { placement: "aboveEditor" });
		registry.mountWidget("side", ["sidebar widget"], { placement: "sidebar" });

		expect(registry.createSlotPublication("aboveEditor").component.render(20)).toEqual(["first", "second"]);
		expect(registry.createSlotPublication("sidebar").component.render(20)).toEqual(["sidebar widget"]);
		registry.dispose();
	});

	it("tracks extension statuses without painting them as a visible status strip", async () => {
		// Main (classic InteractiveMode) never renders `ctx.ui.setStatus()` text anywhere:
		// SumoCode's custom footer (`installFooter` in src/footer.ts) replaces Pi's default
		// footer and never queries extension statuses, and `SumoExtensionUIAdapter.onStatus`
		// is never wired to a sink on main. `ExtensionStatusPublication` exists only so RPC
		// mode's `getStatuses()` still gives a readback -- it must not render a raw "key:
		// text" strip above the editor, since that has no equivalent on main.
		const registry = await makeRegistry();
		const statuses = new ExtensionStatusPublication();
		registry.mountStatus(statuses.component);

		statuses.setStatus("task-mode", "done");
		statuses.setStatus("empty", undefined);

		expect(registry.createSlotPublication("status").component.render(40)).toEqual([]);
		expect(statuses.getStatuses().get("task-mode")).toBe("done");
		registry.dispose();
	});
});
