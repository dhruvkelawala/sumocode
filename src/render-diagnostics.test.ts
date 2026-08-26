import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RenderComponent = { render(width: number): string[] };
type ComponentFactory = (...args: unknown[]) => RenderComponent;

interface DiagnosticsTestCtx {
	hasUI: boolean;
	cwd: string;
	ui: {
		setFooter(factory: ComponentFactory): void;
		setHeader(factory: ComponentFactory): void;
		setEditorComponent(factory: ComponentFactory): void;
		setWidget(key: string, content: ComponentFactory): void;
	};
	sessionManager: { getBranch(): unknown[] };
}

type SessionStartHandler = (event: { type: string }, ctx: DiagnosticsTestCtx) => void;

function makePi() {
	let handler: SessionStartHandler | undefined;
	const onSpy = vi.fn((eventName: string, h: SessionStartHandler) => {
		if (eventName === "session_start") handler = h;
	});
	const pi = { on: onSpy };
	// SAFETY: the on() double supplies the registrar surface installRenderDiagnostics reads.
	return {
		pi: pi as never,
		onSpy,
		fireSessionStart: (ctx: DiagnosticsTestCtx) => handler?.({ type: "session_start" }, ctx),
	};
}

type RegisteredFactories = {
	footer?: ComponentFactory;
	header?: ComponentFactory;
	editor?: ComponentFactory;
	widgets: Map<string, ComponentFactory>;
};

function makeCtx() {
	// Capture what the wrapper passes through to the underlying ctx.ui setters,
	// because instrumentUi mutates the methods on ctx.ui in-place — keeping a
	// separate spy reference would also be mutated.
	const registered: RegisteredFactories = { widgets: new Map() };
	const ui = {
		setFooter: (factory: ComponentFactory): void => {
			registered.footer = factory;
		},
		setHeader: (factory: ComponentFactory): void => {
			registered.header = factory;
		},
		setEditorComponent: (factory: ComponentFactory): void => {
			registered.editor = factory;
		},
		setWidget: (key: string, content: ComponentFactory): void => {
			registered.widgets.set(key, content);
		},
	};
	const getBranchSpy = vi.fn(() => []);
	const ctx: DiagnosticsTestCtx = {
		hasUI: true,
		cwd: "/tmp",
		ui,
		sessionManager: { getBranch: getBranchSpy },
	};
	return { ctx, registered, getBranchSpy };
}

describe("render-diagnostics — disabled (no SUMO_TUI_DIAG_FILE)", () => {
	beforeEach(() => {
		delete process.env.SUMO_TUI_DIAG_FILE;
		vi.resetModules();
	});

	it("does not subscribe to events or wrap ui surfaces", async () => {
		const { installRenderDiagnostics } = await import("./render-diagnostics.js");
		const { pi, onSpy } = makePi();
		installRenderDiagnostics(pi);
		expect(onSpy.mock.calls.length).toBe(0);
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

	interface DiagEvent {
		event: string;
		target?: string;
		width?: number;
		lines?: number;
	}

	function readEvents(): DiagEvent[] {
		const text = readFileSync(file, "utf8").trim();
		if (!text) return [];
		return text.split("\n").map((line) =>
			// SAFETY: the diagnostics file is JSONL written by the instrumented wrapper
			// with the event fields asserted below.
			JSON.parse(line) as DiagEvent,
		);
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

		// SAFETY: the ui double's setFooter is captured via the registered-factory wrapper.
		ctx.ui.setFooter(factory);

		expect(registered.footer).toBeTypeOf("function");
		const component = registered.footer!({}, {}, {});

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
		const branch = ctx.sessionManager.getBranch();
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

		// SAFETY: the ui double's setEditorComponent is captured via the registered-factory wrapper.
		ctx.ui.setEditorComponent(factory);
		expect(registered.editor).toBeTypeOf("function");
		// SAFETY: the registered editor factory returns the Editor instance created above.
		const result = registered.editor!({}, {}, {}) as Editor;

		// Same instance — only `render` is patched.
		expect(result).toBe(editor);
		expect(result.extra).toBe("preserved");
		expect(result.customMethod()).toBe("still here");
		expect(result.render(60)).toEqual(["editor-row"]);
	});
});
