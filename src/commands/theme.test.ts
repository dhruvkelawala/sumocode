import { afterEach, describe, expect, it, vi } from "vitest";
import { resetThemeRegistryForTests } from "../themes/index.js";
import { formatActiveThemeMessage, formatThemeList, registerThemeCommand, THEME_RESULT_CUSTOM_TYPE } from "./theme.js";

describe("/sumo:theme", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("formats the active theme with a description", () => {
		expect(formatActiveThemeMessage()).toContain("theme: cathedral");
		expect(formatActiveThemeMessage()).toContain("19th-century scriptorium");
	});

	it("lists registered themes and marks the active one", () => {
		expect(formatThemeList()).toEqual([
			"* cathedral — 19th-century scriptorium: warm walnut, parchment foreground, burnt-orange accents.",
		]);
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
				details: { tone: "info", lines: [expect.stringContaining("* cathedral")] },
			}),
			{ triggerTurn: false },
		);
	});

	it("does not trigger a turn or send to LLM", async () => {
		const { handler, sendMessage } = registerHarness();

		await handler("list", uiContext());

		expect(sendMessage).toHaveBeenCalledWith(expect.anything(), { triggerTurn: false });
	});

	it("switches known themes through the registry and Pi theme API", async () => {
		const { handler, sendMessage } = registerHarness();
		const setTheme = vi.fn(() => ({ success: true }));

		await handler(" Cathedral ", uiContext({ setTheme }));

		expect(setTheme).toHaveBeenCalledWith("cathedral");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "info", lines: ["theme set: cathedral"] } }),
			{ triggerTurn: false },
		);
	});

	it("warns for known themes when Pi theme application fails", async () => {
		const { handler, sendMessage } = registerHarness();
		const setTheme = vi.fn(() => ({ success: false, error: "Theme API unavailable" }));

		await handler("cathedral", uiContext({ setTheme }));

		expect(setTheme).toHaveBeenCalledWith("cathedral");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "warning", lines: ["theme failed: Theme API unavailable"] } }),
			{ triggerTurn: false },
		);
		expect(sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "info", lines: ["theme set: cathedral"] } }),
			expect.anything(),
		);
	});

	it("warns for unknown themes without calling Pi theme API", async () => {
		const { handler, sendMessage } = registerHarness();
		const setTheme = vi.fn(() => ({ success: true }));

		await handler("amber-crt", uiContext({ setTheme }));

		expect(setTheme).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { tone: "warning", lines: ["Unknown SumoCode theme: amber-crt"] } }),
			{ triggerTurn: false },
		);
	});
});

interface RegisteredHarness {
	handler: (args: string, ctx: any) => Promise<void>;
	sendMessage: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
}

function registerHarness(): RegisteredHarness {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
		handler = options.handler;
	});
	const sendMessage = vi.fn();
	const registerMessageRenderer = vi.fn();

	registerThemeCommand({ registerCommand, sendMessage, registerMessageRenderer } as never);
	if (!handler) throw new Error("handler was not registered");
	return { handler, sendMessage, registerMessageRenderer };
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
