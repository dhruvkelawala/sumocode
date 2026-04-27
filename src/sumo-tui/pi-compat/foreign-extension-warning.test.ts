import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	ForeignExtensionWarning,
	createForeignAwareUIContext,
	isForeignExtension,
	packageNameForExtension,
} from "./foreign-extension-warning.js";

class TestComponent implements Component {
	public invalidate(): void {}
	public render(_width: number): string[] {
		return ["component"];
	}
}

function baseUI(): ExtensionUIContext & { setHeader: ReturnType<typeof vi.fn> } {
	const setHeader = vi.fn();
	return {
		select: vi.fn(),
		confirm: vi.fn(),
		input: vi.fn(),
		notify: vi.fn(),
		onTerminalInput: vi.fn(() => () => undefined),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		setHeader,
		setTitle: vi.fn(),
		custom: vi.fn(),
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn(() => ""),
		editor: vi.fn(),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		get theme(): Theme {
			return {} as Theme;
		},
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} as unknown as ExtensionUIContext & { setHeader: ReturnType<typeof vi.fn> };
}

describe("foreign extension warning", () => {
	it("parses package names and classifies SumoCode-owned packages", () => {
		expect(packageNameForExtension("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(isForeignExtension("npm:left-pad@1.0.0")).toBe(true);
		expect(isForeignExtension("@dhruvkelawala/sumocode")).toBe(false);
		expect(isForeignExtension("@sumodeus/cathedral-tools")).toBe(false);
	});

	it("foreign extension setHeader warns once and no-ops", () => {
		const notify = vi.fn();
		const debug = vi.fn();
		const base = baseUI();
		const guarded = createForeignAwareUIContext(base, {
			notify,
			debug,
			resolveCallerExtensionName: () => "left-pad",
		});

		guarded.setHeader(() => new TestComponent());
		guarded.setHeader(() => new TestComponent());

		expect(base.setHeader).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toContain("Extension 'left-pad'");
		expect(debug).toHaveBeenCalledTimes(2);
	});

	it("SumoCode-owned extension setHeader mounts normally", () => {
		const notify = vi.fn();
		const base = baseUI();
		const guarded = createForeignAwareUIContext(base, {
			notify,
			resolveCallerExtensionName: () => "@dhruvkelawala/sumocode",
		});

		guarded.setHeader(() => new TestComponent());

		expect(base.setHeader).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});

	it("warns once per foreign extension", () => {
		const notify = vi.fn();
		const warning = new ForeignExtensionWarning({ notify });

		warning.warn("left-pad");
		warning.warn("left-pad");
		warning.warn("other-ext");

		expect(notify).toHaveBeenCalledTimes(2);
		expect(warning.getWarnedExtensions()).toEqual(["left-pad", "other-ext"]);
	});
});
