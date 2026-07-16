import { describe, expect, it, vi } from "vitest";
import { installInputHints, splashInvocationHint } from "./input-hints.js";

type Handler = (...args: unknown[]) => unknown;

describe("installInputHints", () => {
	it("subscribes to session_start and selector updates", () => {
		const on = vi.fn();
		installInputHints({ on } as never);
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(on).toHaveBeenCalledWith("model_select", expect.any(Function));
		expect(on).toHaveBeenCalledWith("thinking_level_select", expect.any(Function));
	});

	it("on session_start, registers a widget below the editor", () => {
		const handlers = new Map<string, Handler[]>();
		const on = vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		});
		installInputHints({ on } as never);

		const setWidget = vi.fn();
		const ctx = { hasUI: true, ui: { setWidget } } as unknown;
		const startHandlers = handlers.get("session_start") ?? [];
		for (const handler of startHandlers) handler({ type: "session_start" }, ctx);

		expect(setWidget).toHaveBeenCalledWith(
			"sumocode-input-hints",
			expect.any(Function),
			{ placement: "belowEditor" },
		);
	});

	it("ignores session_start when hasUI is false (RPC/print mode)", () => {
		const handlers = new Map<string, Handler[]>();
		const on = vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		});
		installInputHints({ on } as never);

		const setWidget = vi.fn();
		const ctx = { hasUI: false, ui: { setWidget } } as unknown;
		const startHandlers = handlers.get("session_start") ?? [];
		for (const handler of startHandlers) handler({ type: "session_start" }, ctx);

		expect(setWidget).not.toHaveBeenCalled();
	});

	it("widget factory returns a Component that renders the keybind hint row", () => {
		const handlers = new Map<string, Handler[]>();
		const on = vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		});
		installInputHints({ on } as never);

		let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
		const setWidget = vi.fn((_key: string, f: typeof factory) => {
			factory = f;
		});
		// Active state: branch contains a real message entry
		const ctx = {
			hasUI: true,
			cwd: "/tmp/sumocode",
			ui: { setWidget },
			sessionManager: { getBranch: () => [{ type: "message" }] },
		} as unknown;
		const startHandlers = handlers.get("session_start") ?? [];
		for (const handler of startHandlers) handler({ type: "session_start" }, ctx);

		const component = factory?.(undefined, undefined);
		const lines = component!.render(80);
		expect(lines.length).toBe(1);
		const stripped = lines[0]!.replace(/\u001b\[[0-9;]*m/g, "");
		expect(stripped).toContain("sumocode");
		expect(stripped).toContain("CTRL+/ · COMMANDS");
		expect(stripped).not.toContain("TAB · AGENTS");
		expect(stripped).not.toContain("AWAITING PROMPT");

		const portraitLines = component!.render(60).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
		expect(portraitLines).toHaveLength(1);
		expect(portraitLines[0]).toHaveLength(60);
		expect(portraitLines[0]!.startsWith(" ")).toBe(true);
		expect(portraitLines[0]!.endsWith(" ")).toBe(true);
		expect(portraitLines[0]).toContain("CTRL+/ · COMMANDS");
	});

	it("widget factory renders BOTH hints on splash (no messages yet)", () => {
		const handlers = new Map<string, Handler[]>();
		const on = vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		});
		installInputHints({ on } as never);

		let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
		const setWidget = vi.fn((_key: string, f: typeof factory) => {
			factory = f;
		});
		// Splash state: branch has no message entries
		const ctx = {
			hasUI: true,
			ui: { setWidget },
			sessionManager: { getBranch: () => [] },
		} as unknown;
		const startHandlers = handlers.get("session_start") ?? [];
		for (const handler of startHandlers) handler({ type: "session_start" }, ctx);

		const component = factory?.(undefined, undefined);
		const lines = component!.render(120);
		expect(lines.length).toBe(1);
		const stripped = lines[0]!.replace(/\u001b\[[0-9;]*m/g, "");
		expect(stripped).toContain("╰─ no model · thinking");
		expect(stripped).toContain("CTRL+/ · COMMANDS");
		expect(stripped).not.toContain("AWAITING PROMPT");
		expect(stripped).not.toContain("TAB · AGENTS");
	});

	it("updates splash hint when model or thinking changes", () => {
		const handlers = new Map<string, Handler[]>();
		const on = vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		});
		installInputHints({ on } as never);

		let factory: ((tui: { requestRender: () => void }, theme: unknown) => { render(width: number): string[] }) | undefined;
		const setWidget = vi.fn((_key: string, f: typeof factory) => {
			factory = f;
		});
		const ctx = {
			hasUI: true,
			ui: { setWidget },
			model: { id: "claude-sonnet-4.6" },
			sessionManager: { getBranch: () => [{ type: "thinking_level_change", thinkingLevel: "high" }] },
		} as unknown;
		for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);

		const requestRender = vi.fn();
		const component = factory!({ requestRender }, undefined);
		const initial = component.render(120)[0]!.replace(/\u001b\[[0-9;]*m/g, "");
		expect(initial).toContain("╰─ claude-sonnet-4.6 · high");

		for (const handler of handlers.get("model_select") ?? []) handler({ type: "model_select", model: { id: "gpt-5.3-codex" } });
		for (const handler of handlers.get("thinking_level_select") ?? []) handler({ type: "thinking_level_select", level: "xhigh" });

		const updated = component.render(120)[0]!.replace(/\u001b\[[0-9;]*m/g, "");
		expect(updated).toContain("╰─ gpt-5.3-codex · xhigh");
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});

describe("splashInvocationHint", () => {
	it("formats model and thinking level for the splash footer", () => {
		expect(splashInvocationHint("gpt-5.5", "high")).toBe("╰─ gpt-5.5 · high");
	});

	it("falls back to thinking when the level is unavailable", () => {
		expect(splashInvocationHint("no model", undefined)).toBe("╰─ no model · thinking");
	});
});
