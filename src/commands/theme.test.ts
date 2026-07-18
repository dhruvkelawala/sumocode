import { afterEach, describe, expect, it, vi } from "vitest";
import { resetThemeRegistryForTests, setActiveTheme } from "../themes/index.js";
import { formatActiveThemeMessage, formatThemeList, registerThemeCommand, THEME_RESULT_CUSTOM_TYPE } from "./theme.js";

describe("/sumo:theme", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("formats the active theme with a description", () => {
		expect(formatActiveThemeMessage()).toContain("theme: cathedral");
		expect(formatActiveThemeMessage()).toContain("19th-century scriptorium");
	});

	it("lists all five registered themes in registry order and marks the active one", () => {
		const lines = formatThemeList();
		expect(lines.map((line) => line.slice(2).split(" — ")[0])).toEqual(["cathedral", "amber-crt", "obsidian", "herdr", "ultraviolet-core"]);
		expect(lines).toContain("* cathedral — 19th-century scriptorium: warm walnut, parchment foreground, burnt-orange accents.");
		expect(lines.some((line) => line.startsWith("  obsidian"))).toBe(true);
		expect(lines).toContain("  herdr — Electric-green operator terminal — phosphor focus, amber execution, sharp hacker chrome.");
		expect(lines).toContain("  ultraviolet-core — Ultraviolet command layer — violet focus, ice signal, deep spatial surfaces.");
	});

	it("registers a custom message renderer for theme results", () => {
		const harness = registerHarness();
		expect(harness.registerMessageRenderer).toHaveBeenCalledWith(THEME_RESULT_CUSTOM_TYPE, expect.any(Function));
	});

	it("pushes the active theme into chat history when called with no args", async () => {
		const { handler, sendMessage } = registerHarness();

		await handler("", uiContext());

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: THEME_RESULT_CUSTOM_TYPE,
				display: true,
				details: { tone: "info", lines: [expect.stringContaining("theme: cathedral")] },
			}),
			{ triggerTurn: false },
		);
	});

	it("pushes the theme list into chat history when called with list", async () => {
		const { handler, sendMessage } = registerHarness();

		await handler("list", uiContext());

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: THEME_RESULT_CUSTOM_TYPE,
				display: true,
				details: { tone: "info", lines: expect.arrayContaining([expect.stringContaining("* cathedral")]) },
			}),
			{ triggerTurn: false },
		);
	});

	it("does not trigger a turn or send to LLM", async () => {
		const { handler, sendMessage } = registerHarness();

		await handler("list", uiContext());

		expect(sendMessage).toHaveBeenCalledWith(expect.anything(), { triggerTurn: false });
	});

	it("switches known themes through the registry and Pi theme API and persists the preference", async () => {
		const { handler, sendMessage, persistTheme } = registerHarness();
		const setTheme = vi.fn(() => ({ success: true }));

		await handler(" Cathedral ", uiContext({ setTheme }));

		expect(setTheme).toHaveBeenCalledWith("cathedral");
		expect(persistTheme).toHaveBeenCalledWith("cathedral");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "info", lines: ["theme set: cathedral"] } }),
			{ triggerTurn: false },
		);
	});

	it("applies herdr directly through the registry, Pi theme API, and persistence", async () => {
		const { handler, sendMessage, persistTheme } = registerHarness();
		const setTheme = vi.fn(() => ({ success: true }));

		await handler("herdr", uiContext({ setTheme }));

		expect(setTheme).toHaveBeenCalledWith("herdr");
		expect(persistTheme).toHaveBeenCalledWith("herdr");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "info", lines: ["theme set: herdr"] } }),
			{ triggerTurn: false },
		);
	});

	it("applies ultraviolet-core directly through the registry, Pi theme API, and persistence", async () => {
		const { handler, sendMessage, persistTheme } = registerHarness();
		const setTheme = vi.fn(() => ({ success: true }));

		await handler("ultraviolet-core", uiContext({ setTheme }));

		expect(setTheme).toHaveBeenCalledWith("ultraviolet-core");
		expect(persistTheme).toHaveBeenCalledWith("ultraviolet-core");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "info", lines: ["theme set: ultraviolet-core"] } }),
			{ triggerTurn: false },
		);
	});

	it("applies SumoCode themes even when Pi theme API does not know them", async () => {
		const { handler, sendMessage } = registerHarness();
		const setTheme = vi.fn(() => ({ success: false, error: "Theme not found: obsidian" }));

		await handler("obsidian", uiContext({ setTheme }));

		expect(setTheme).toHaveBeenCalledWith("obsidian");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				details: {
					tone: "info",
					lines: ["theme set: obsidian", "(Pi theme not found: Theme not found: obsidian)"],
				},
			}),
			{ triggerTurn: false },
		);
	});

	it("warns for unknown themes without calling Pi theme API or persistence", async () => {
		const { handler, sendMessage, persistTheme } = registerHarness();
		const setTheme = vi.fn(() => ({ success: true }));

		await handler("abyssal-tide", uiContext({ setTheme }));

		expect(setTheme).not.toHaveBeenCalled();
		expect(persistTheme).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "warning", lines: ["Unknown SumoCode theme: abyssal-tide"] } }),
			{ triggerTurn: false },
		);
	});

	describe("cycle shortcut", () => {
		it("registers ctrl+shift+t and alt+t", () => {
			const { shortcuts } = registerHarness();
			expect([...shortcuts.keys()].sort()).toEqual(["alt+t", "ctrl+shift+t"]);
		});

		it("cycles obsidian → herdr → ultraviolet-core → cathedral through the shortcut", async () => {
			const { shortcuts, persistTheme } = registerHarness();
			const setTheme = vi.fn(() => ({ success: true }));
			const notify = vi.fn();
			setActiveTheme("obsidian");

			await shortcuts.get("ctrl+shift+t")?.({ hasUI: true, ui: { notify, setTheme } });
			expect(setTheme).toHaveBeenLastCalledWith("herdr");
			expect(persistTheme).toHaveBeenLastCalledWith("herdr");
			expect(notify).toHaveBeenLastCalledWith("theme: herdr", "info");

			await shortcuts.get("ctrl+shift+t")?.({ hasUI: true, ui: { notify, setTheme } });
			expect(setTheme).toHaveBeenLastCalledWith("ultraviolet-core");
			expect(persistTheme).toHaveBeenLastCalledWith("ultraviolet-core");
			expect(notify).toHaveBeenLastCalledWith("theme: ultraviolet-core", "info");

			await shortcuts.get("ctrl+shift+t")?.({ hasUI: true, ui: { notify, setTheme } });
			expect(setTheme).toHaveBeenLastCalledWith("cathedral");
			expect(notify).toHaveBeenLastCalledWith("theme: cathedral", "info");
		});

		it("cycles theme through Pi UI, persists, and notifies on success", async () => {
			// PRD-pinned cycle order: cathedral → amber-crt → obsidian → herdr → ultraviolet-core → cathedral.
			const { shortcuts, persistTheme } = registerHarness();
			const setTheme = vi.fn(() => ({ success: true }));
			const notify = vi.fn();

			await shortcuts.get("ctrl+shift+t")?.({ hasUI: true, ui: { notify, setTheme } });

			expect(setTheme).toHaveBeenCalledWith("amber-crt");
			expect(persistTheme).toHaveBeenCalledWith("amber-crt");
			expect(notify).toHaveBeenCalledWith("theme: amber-crt", "info");
		});

		it("alt+t fallback uses the same handler", async () => {
			const { shortcuts } = registerHarness();
			const setTheme = vi.fn(() => ({ success: true }));
			const notify = vi.fn();

			await shortcuts.get("alt+t")?.({ hasUI: true, ui: { notify, setTheme } });

			expect(setTheme).toHaveBeenCalledWith("amber-crt");
			expect(notify).toHaveBeenCalledWith("theme: amber-crt", "info");
		});

		it("cycles SumoCode theme even when Pi theme API rejects the cycle", async () => {
			const { shortcuts } = registerHarness();
			const setTheme = vi.fn(() => ({ success: false, error: "Theme API unavailable" }));
			const notify = vi.fn();

			await shortcuts.get("ctrl+shift+t")?.({ hasUI: true, ui: { notify, setTheme } });

			expect(notify).toHaveBeenCalledWith("theme: amber-crt (Theme API unavailable)", "info");
		});

		it("warns when cycling succeeds but persistence fails", async () => {
			const { shortcuts } = registerHarness({ persistTheme: vi.fn(() => ({ success: false, error: "EACCES" })) });
			const setTheme = vi.fn(() => ({ success: true }));
			const notify = vi.fn();

			await shortcuts.get("ctrl+shift+t")?.({ hasUI: true, ui: { notify, setTheme } });

			expect(notify).toHaveBeenCalledWith("theme: amber-crt (EACCES)", "warning");
		});
	});
});

interface RegisteredHarness {
	handler: (args: string, ctx: any) => Promise<void>;
	shortcuts: Map<string, (ctx: any) => void | Promise<void>>;
	sendMessage: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	persistTheme: ReturnType<typeof vi.fn>;
}

function registerHarness(options: { persistTheme?: any } = {}): RegisteredHarness {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const shortcuts = new Map<string, (ctx: any) => void | Promise<void>>();
	const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
		handler = options.handler;
	});
	const registerShortcut = vi.fn((shortcut: string, options: { handler: (ctx: any) => void | Promise<void> }) => {
		shortcuts.set(String(shortcut), options.handler);
	});
	const sendMessage = vi.fn();
	const registerMessageRenderer = vi.fn();
	const persistTheme = options.persistTheme ?? vi.fn(() => ({ success: true }));

	registerThemeCommand({ registerCommand, registerShortcut, sendMessage, registerMessageRenderer } as never, { persistTheme });
	if (!handler) throw new Error("handler was not registered");
	return { handler, shortcuts, sendMessage, registerMessageRenderer, persistTheme };
}

function uiContext(options: { setTheme?: ReturnType<typeof vi.fn> } = {}): any {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			setTheme: options.setTheme ?? vi.fn(() => ({ success: true })),
		},
	};
}
