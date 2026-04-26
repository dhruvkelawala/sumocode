import { describe, expect, it, vi } from "vitest";
import { installInputHints } from "./input-hints.js";

type Handler = (...args: unknown[]) => unknown;

describe("installInputHints", () => {
	it("subscribes to session_start", () => {
		const on = vi.fn();
		installInputHints({ on } as never);
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
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
			ui: { setWidget },
			sessionManager: { getBranch: () => [{ type: "message" }] },
		} as unknown;
		const startHandlers = handlers.get("session_start") ?? [];
		for (const handler of startHandlers) handler({ type: "session_start" }, ctx);

		const component = factory?.(undefined, undefined);
		const lines = component!.render(80);
		expect(lines.length).toBe(1);
		const stripped = lines[0]!.replace(/\u001b\[[0-9;]*m/g, "");
		expect(stripped).toContain("TAB · AGENTS  CTRL+P · COMMANDS");
		expect(stripped).not.toContain("INPUT PROTOCOL AWAITING COMMAND");
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
		expect(stripped).toContain("INPUT PROTOCOL AWAITING COMMAND");
		expect(stripped).toContain("TAB · AGENTS  CTRL+P · COMMANDS");
	});
});
