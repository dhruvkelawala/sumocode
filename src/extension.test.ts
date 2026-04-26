import { describe, expect, it, vi } from "vitest";
import sumocode from "./extension.js";

type Handler = (...args: unknown[]) => unknown;

function buildPiStub() {
	const handlers = new Map<string, Handler[]>();

	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
	};

	return { pi, handlers };
}

function buildCtxStub() {
	return {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => undefined,
		model: undefined,
		ui: {
			notify: vi.fn(),
			custom: vi.fn(() => Promise.resolve()),
			setFooter: vi.fn(),
			setHeader: vi.fn(),
			setWidget: vi.fn(),
			setWorkingIndicator: vi.fn(),
		},
	};
}

describe("sumocode extension", () => {
	it("does not push a 'SumoCode loaded' notification on session_start", () => {
		const { pi, handlers } = buildPiStub();

		sumocode(pi as never);

		const ctx = buildCtxStub();
		const sessionStart = handlers.get("session_start") ?? [];
		for (const handler of sessionStart) {
			handler({ type: "session_start" }, ctx as never);
		}

		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
