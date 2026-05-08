import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionStatusComponent, COMPACTION_INDICATOR_WIDGET_KEY, installCompactionIndicator } from "./compaction-indicator.js";

const ENV_KEY = "SUMO_TUI";
let originalEnv: string | undefined;

beforeEach(() => {
	originalEnv = process.env[ENV_KEY];
	vi.useFakeTimers();
});

afterEach(() => {
	if (originalEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = originalEnv;
	vi.useRealTimers();
});

// ── CompactionStatusComponent unit tests ──────────────────────────────────────

describe("CompactionStatusComponent", () => {
	it("renders exactly one row", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Compacting…", tui);
		try {
			expect(c.render(80)).toHaveLength(1);
		} finally {
			c.dispose();
		}
	});

	it("row contains the label text", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Auto-compacting…", tui);
		try {
			const row = c.render(80)[0]!;
			expect(row).toContain("Auto-compacting…");
		} finally {
			c.dispose();
		}
	});

	it("row contains ━ (trace) and ─ (track) bar chars", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Compacting…", tui);
		try {
			const row = c.render(80)[0]!;
			const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
			// At tick 0 bar starts with glyph + track chars.
			expect(plain).toMatch(/[━─]/);
		} finally {
			c.dispose();
		}
	});

	it("bar starts mostly empty (tick 0, no fill yet)", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Compacting…", tui);
		try {
			const row = c.render(80)[0]!;
			const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
			// At tick 0, filledCells === 0: only unfilled track + glyph
			expect(plain).not.toMatch(/▓▓/); // no solid fill yet
		} finally {
			c.dispose();
		}
	});

	it("bar grows after ticks", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Compacting…", tui);
		try {
			// With PLATEAU_TICKS=400 we need enough ticks to see fill start.
			// 80 ticks (8 s) → ~18 % of barWidth ≈ 5 filled cells.
			vi.advanceTimersByTime(8000);
			const row = c.render(80)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
			expect(row).toContain("━");
		} finally {
			c.dispose();
		}
	});

	it("bar fill plateaus at ~90% after 40 s and holds", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Compacting…", tui);
		try {
			vi.advanceTimersByTime(40_000);
			const rowA = c.render(80)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
			vi.advanceTimersByTime(30_000);
			const rowB = c.render(80)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
			const traceA = [...rowA].filter((ch) => ch === "━").length;
			const traceB = [...rowB].filter((ch) => ch === "━").length;
			expect(traceA).toBe(traceB);
			expect(traceA).toBeGreaterThan(0);
		} finally {
			c.dispose();
		}
	});

	it("dispose() stops the timer so requestRender is not called after disposal", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Compacting…", tui);
		c.dispose();
		vi.advanceTimersByTime(2000);
		expect(tui.requestRender).not.toHaveBeenCalled();
	});

	it("ticks requestRender on each interval", () => {
		const tui = { requestRender: vi.fn() };
		const c = new CompactionStatusComponent("Compacting…", tui);
		try {
			vi.advanceTimersByTime(500); // 5 ticks at 100ms
			expect(tui.requestRender).toHaveBeenCalledTimes(5);
		} finally {
			c.dispose();
		}
	});
});

// ── installCompactionIndicator integration tests ──────────────────────────────

function buildPiStub() {
	const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
	const pi = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			handlers[event] ??= [];
			handlers[event].push(handler);
		}),
	};
	const fire = async (event: string, payload: unknown, ctx: unknown) => {
		for (const h of handlers[event] ?? []) await h(payload, ctx);
	};
	return { pi, fire };
}

function buildCtxStub() {
	const setWidget = vi.fn();
	return { ctx: { hasUI: true, ui: { setWidget } }, setWidget };
}

describe("compaction indicator — retained mode", () => {
	beforeEach(() => { process.env[ENV_KEY] = "1"; });

	it("registers session_before_compact, session_compact, and session_shutdown handlers", () => {
		const { pi } = buildPiStub();
		installCompactionIndicator(pi as never);
		const registered = pi.on.mock.calls.map((c) => c[0]);
		expect(registered).toContain("session_before_compact");
		expect(registered).toContain("session_compact");
		expect(registered).toContain("session_shutdown");
	});

	it("mounts animated component for manual /compact (customInstructions set)", async () => {
		const { pi, fire } = buildPiStub();
		const { ctx, setWidget } = buildCtxStub();
		installCompactionIndicator(pi as never);

		await fire("session_before_compact", { customInstructions: "summarise recent" }, ctx);

		expect(setWidget).toHaveBeenCalledWith(
			COMPACTION_INDICATOR_WIDGET_KEY,
			expect.any(Function),
			{ placement: "aboveEditor" },
		);
		const factory = setWidget.mock.calls[0][1] as (tui: { requestRender(): void }) => { render(w: number): string[]; dispose?(): void };
		const c = factory({ requestRender: vi.fn() });
		const row = c.render(80)[0]!;
		expect(row).toContain("Compacting…");
		c.dispose?.();
	});

	it("mounts animated component with 'Auto-compacting…' when customInstructions is undefined", async () => {
		const { pi, fire } = buildPiStub();
		const { ctx, setWidget } = buildCtxStub();
		installCompactionIndicator(pi as never);

		await fire("session_before_compact", { customInstructions: undefined }, ctx);

		const factory = setWidget.mock.calls[0][1] as (tui: { requestRender(): void }) => { render(w: number): string[]; dispose?(): void };
		const c = factory({ requestRender: vi.fn() });
		const row = c.render(80)[0]!;
		expect(row).toContain("Auto-compacting…");
		c.dispose?.();
	});

	it("clears widget on session_compact after completion hold", async () => {
		const { pi, fire } = buildPiStub();
		const { ctx, setWidget } = buildCtxStub();
		installCompactionIndicator(pi as never);

		await fire("session_before_compact", { customInstructions: undefined }, ctx);
		const factory = setWidget.mock.calls[0][1] as (tui: { requestRender(): void }) => { render(w: number): string[]; dispose?(): void };
		const c = factory({ requestRender: vi.fn() });

		// session_compact awaits markComplete() which setTimeout 700 ms.
		// Fire event, then advance timers to let the hold expire.
		const compactPromise = fire("session_compact", {}, ctx);
		vi.advanceTimersByTime(800);
		await compactPromise;

		expect(setWidget).toHaveBeenLastCalledWith(
			COMPACTION_INDICATOR_WIDGET_KEY,
			undefined,
			{ placement: "aboveEditor" },
		);
		c.dispose?.();
	});

	it("clears widget on session_shutdown", async () => {
		const { pi, fire } = buildPiStub();
		const { ctx, setWidget } = buildCtxStub();
		installCompactionIndicator(pi as never);

		await fire("session_before_compact", { customInstructions: undefined }, ctx);
		await fire("session_shutdown", { reason: "quit" }, ctx);

		expect(setWidget).toHaveBeenLastCalledWith(
			COMPACTION_INDICATOR_WIDGET_KEY,
			undefined,
			{ placement: "aboveEditor" },
		);
	});

	it("does not call setWidget when hasUI is false", async () => {
		const { pi, fire } = buildPiStub();
		const { setWidget } = buildCtxStub();
		const headlessCtx = { hasUI: false, ui: { setWidget } };
		installCompactionIndicator(pi as never);

		await fire("session_before_compact", { customInstructions: undefined }, headlessCtx);

		expect(setWidget).not.toHaveBeenCalled();
	});

	it("does not double-clear when session_compact fires without a prior before_compact", async () => {
		const { pi, fire } = buildPiStub();
		const { ctx, setWidget } = buildCtxStub();
		installCompactionIndicator(pi as never);

		await fire("session_compact", {}, ctx);

		expect(setWidget).not.toHaveBeenCalled();
	});
});

describe("compaction indicator — classic Pi (no SUMO_TUI)", () => {
	beforeEach(() => { delete process.env[ENV_KEY]; });

	it("registers no event handlers in classic mode", () => {
		const { pi } = buildPiStub();
		installCompactionIndicator(pi as never);
		expect(pi.on).not.toHaveBeenCalled();
	});
});
