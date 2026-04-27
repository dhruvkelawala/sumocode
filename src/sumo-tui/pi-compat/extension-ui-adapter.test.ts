import type { KeybindingsManager, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, EditorComponent, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadYoga } from "../layout/yoga.js";
import { ModalManager } from "../widgets/modal.js";
import { NotificationCenter } from "../widgets/notification.js";
import { SumoExtensionUIAdapter } from "./extension-ui-adapter.js";
import { RegionRegistry } from "./region-registry.js";

class TestComponent implements Component {
	public invalidate(): void {}
	public render(_width: number): string[] {
		return ["component"];
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
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 0,
		onBranchChange: () => () => undefined,
	};
}

async function makeAdapter(): Promise<{
	registry: RegionRegistry;
	notifications: NotificationCenter;
	modals: ModalManager;
	adapter: SumoExtensionUIAdapter;
}> {
	const yoga = await loadYoga();
	const tui = fakeTui();
	const theme = fakeTheme();
	const editorTheme = fakeEditorTheme();
	const keybindings = fakeKeybindings();
	const registry = new RegionRegistry({
		yoga,
		tui,
		theme,
		editorTheme,
		keybindings,
		footerData: fakeFooterData(),
	});
	const notifications = new NotificationCenter();
	const modals = new ModalManager();
	const adapter = new SumoExtensionUIAdapter({
		regionRegistry: registry,
		tui,
		theme,
		editorTheme,
		keybindings,
		notifications,
		modals,
	});
	return { registry, notifications, modals, adapter };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SumoExtensionUIAdapter", () => {
	it("routes Pi extension UI methods to retained RegionRegistry slots", async () => {
		const { adapter, registry } = await makeAdapter();

		adapter.setHeader(() => new TestComponent());
		adapter.setFooter(() => new TestComponent());
		adapter.setEditorComponent(() => new TestComponent() as unknown as EditorComponent);
		adapter.setWidget("above", () => new TestComponent(), { placement: "aboveEditor" });
		adapter.setWidget("below", ["below"], { placement: "belowEditor" });

		expect(registry.getMounted("__header")?.slot).toBe("header");
		expect(registry.getMounted("__footer")?.slot).toBe("footer");
		expect(registry.getMounted("__editor")?.slot).toBe("editor");
		expect(registry.getMounted("above")?.slot).toBe("aboveEditor");
		expect(registry.getMounted("below")?.slot).toBe("belowEditor");
		registry.dispose();
	});

	it("notify creates a toast that auto-dismisses", async () => {
		vi.useFakeTimers();
		const { adapter, notifications, registry } = await makeAdapter();

		adapter.notify("hello", "info");
		expect(notifications.getToasts()).toHaveLength(1);
		expect(notifications.getToasts()[0]?.message).toBe("hello");

		vi.advanceTimersByTime(3_000);
		expect(notifications.getToasts()).toHaveLength(0);
		registry.dispose();
	});

	it("confirm resolves from modal keyboard input", async () => {
		const { adapter, modals, registry } = await makeAdapter();
		const result = adapter.confirm("Delete", "Continue?");

		modals.handleInput("enter");
		await expect(result).resolves.toBe(true);
		registry.dispose();
	});

	it("select resolves selected option from modal keyboard input", async () => {
		const { adapter, modals, registry } = await makeAdapter();
		const result = adapter.select("Pick", ["alpha", "beta"]);

		modals.handleInput("down");
		modals.handleInput("enter");
		await expect(result).resolves.toBe("beta");
		registry.dispose();
	});
});
