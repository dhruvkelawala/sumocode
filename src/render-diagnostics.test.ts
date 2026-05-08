import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => void;

function makePi(): { pi: ExtensionAPI; fireSessionStart: (ctx: ExtensionContext) => void } {
	let handler: SessionStartHandler | undefined;
	const pi = {
		on: vi.fn((eventName: string, h: SessionStartHandler) => {
			if (eventName === "session_start") handler = h;
		}),
	} as unknown as ExtensionAPI;
	return {
		pi,
		fireSessionStart: (ctx: ExtensionContext) => handler?.({ type: "session_start" }, ctx),
	};
}

type RegisteredFactories = {
	footer?: (...args: unknown[]) => unknown;
	header?: (...args: unknown[]) => unknown;
	editor?: (...args: unknown[]) => unknown;
	widgets: Map<string, (...args: unknown[]) => unknown>;
};

function makeCtx(): {
	ctx: ExtensionContext;
	registered: RegisteredFactories;
	getBranchSpy: ReturnType<typeof vi.fn>;
} {
	// Capture what the wrapper passes through to the underlying ctx.ui setters,
	// because instrumentUi mutates the methods on ctx.ui in-place — keeping a
	// separate spy reference would also be mutated.
	const registered: RegisteredFactories = { widgets: new Map() };
	const ui = {
		setFooter: (factory: (...args: unknown[]) => unknown): void => {
			registered.footer = factory;
		},
		setHeader: (factory: (...args: unknown[]) => unknown): void => {
			registered.header = factory;
		},
		setEditorComponent: (factory: (...args: unknown[]) => unknown): void => {
			registered.editor = factory;
		},
		setWidget: (key: string, content: (...args: unknown[]) => unknown): void => {
			registered.widgets.set(key, content);
		},
	};
	const getBranchSpy = vi.fn(() => []);
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		ui,
		sessionManager: { getBranch: getBranchSpy },
	} as unknown as ExtensionContext;
	return { ctx, registered, getBranchSpy };
}

describe("render-diagnostics — disabled (no SUMO_TUI_DIAG_FILE)", () => {
	beforeEach(() => {
		delete process.env.SUMO_TUI_DIAG_FILE;
		vi.resetModules();
	});

	it("does not subscribe to events or wrap ui surfaces", async () => {
		const { installRenderDiagnostics } = await import("./render-diagnostics.js");
		const { pi } = makePi();
		installRenderDiagnostics(pi);
		expect((pi.on as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
	});
});

describe("render-diagnostics — enabled", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sumo-diag-"));
		file = join(dir, "diag.jsonl");
		process.env.SUMO_TUI_DIAG_FILE = file;
		vi.resetModules();
	});

	afterEach(() => {
		delete process.env.SUMO_TUI_DIAG_FILE;
		rmSync(dir, { recursive: true, force: true });
	});

	function readEvents(): Array<Record<string, unknown>> {
		const text = readFileSync(file, "utf8").trim();
		if (!text) return [];
		return text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("wraps setFooter so component.render gets timed and writes a render_sample for slow renders", async () => {
		const { installRenderDiagnostics } = await import("./render-diagnostics.js");
		const { pi, fireSessionStart } = makePi();
		const { ctx, registered } = makeCtx();

		installRenderDiagnostics(pi);
		fireSessionStart(ctx);

		const slowRender = vi.fn(() => {
			const target = Date.now() + 6;
			while (Date.now() < target) {
				// burn cpu so duration crosses the 4ms slow threshold
			}
			return ["row1", "row2"];
		});
		const factory = vi.fn(() => ({ render: slowRender }));

		(ctx.ui as unknown as { setFooter: (factory: unknown) => void }).setFooter(factory);

		expect(registered.footer).toBeTypeOf("function");
		const component = registered.footer!({}, {}, {}) as { render: (w: number) => string[] };

		const result = component.render(80);
		expect(result).toEqual(["row1", "row2"]);
		expect(slowRender).toHaveBeenCalledWith(80);

		const events = readEvents();
		const samples = events.filter((event) => event.event === "render_sample");
		expect(samples.length).toBeGreaterThan(0);
		expect(samples[0]?.target).toBe("footer");
		expect(samples[0]?.width).toBe(80);
		expect(samples[0]?.lines).toBe(2);
	});

	it("wraps sessionManager.getBranch and counts calls", async () => {
		const { installRenderDiagnostics } = await import("./render-diagnostics.js");
		const { pi, fireSessionStart } = makePi();
		const { ctx, getBranchSpy } = makeCtx();

		installRenderDiagnostics(pi);
		fireSessionStart(ctx);

		// Calling getBranch through ctx.sessionManager should still return the underlying value.
		const branch = (ctx.sessionManager as unknown as { getBranch: () => unknown[] }).getBranch();
		expect(branch).toEqual([]);
		expect(getBranchSpy).toHaveBeenCalledTimes(1);
	});

	it("setEditorComponent wrapping preserves identity (instance methods survive)", async () => {
		const { installRenderDiagnostics } = await import("./render-diagnostics.js");
		const { pi, fireSessionStart } = makePi();
		const { ctx, registered } = makeCtx();

		installRenderDiagnostics(pi);
		fireSessionStart(ctx);

		class Editor {
			public extra = "preserved";
			render(_width: number): string[] {
				return ["editor-row"];
			}
			customMethod(): string {
				return "still here";
			}
		}
		const editor = new Editor();
		const factory = (): Editor => editor;

		(ctx.ui as unknown as { setEditorComponent: (factory: unknown) => void }).setEditorComponent(factory);
		expect(registered.editor).toBeTypeOf("function");
		const result = registered.editor!({}, {}, {}) as Editor;

		// Same instance — only `render` is patched.
		expect(result).toBe(editor);
		expect(result.extra).toBe("preserved");
		expect(result.customMethod()).toBe("still here");
		expect(result.render(60)).toEqual(["editor-row"]);
	});
});
