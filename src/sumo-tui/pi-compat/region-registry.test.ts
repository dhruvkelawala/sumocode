import type { KeybindingsManager, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, EditorComponent, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DIRECTION_LTR, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { RegionRegistry } from "./region-registry.js";

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
});
