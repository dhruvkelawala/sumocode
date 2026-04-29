import { dispatchMouseEvent, type HardwareCursor } from "../render/compositor.js";
import { composite } from "../render/compositor.js";
import { CellBuffer } from "../render/buffer.js";
import type { KeyEvent, KeyTarget } from "../input/key-router.js";
import { KeyRouter } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";

export interface TestBackendOptions {
	readonly cols?: number;
	readonly rows?: number;
}

export interface TestBackendFrame {
	readonly current: CellBuffer;
	readonly previous: CellBuffer | undefined;
	readonly cursor: HardwareCursor | null;
	readonly cols: number;
	readonly rows: number;
}

export interface PilotMouseOptions extends Omit<MouseEvent, "modifiers"> {
	readonly modifiers?: MouseEvent["modifiers"];
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MOUSE_MODIFIERS: MouseEvent["modifiers"] = Object.freeze({ shift: false, alt: false, ctrl: false });

/**
 * Headless retained-renderer backend for unit tests.
 *
 * This is intentionally below the Pi compatibility layer: tests mount SumoNode
 * trees directly, drive them with key/mouse/resize events, and inspect buffers
 * without parsing PTY byte streams. PTY tests remain smoke coverage for the real
 * terminal/Pi boundary.
 */
export class SumoTuiTestBackend {
	public readonly yoga: Yoga;
	public readonly root: SumoNode;
	public readonly keyRouter = new KeyRouter();
	public readonly pilot: SumoTuiPilot;
	private cols: number;
	private rows: number;
	private currentBuffer: CellBuffer | undefined;
	private previousBuffer: CellBuffer | undefined;
	private currentCursor: HardwareCursor | null = null;
	private disposed = false;

	private constructor(yoga: Yoga, options: Required<TestBackendOptions>) {
		this.yoga = yoga;
		this.cols = options.cols;
		this.rows = options.rows;
		this.root = new SumoNode(yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;
		this.pilot = new SumoTuiPilot(this);
	}

	public static async create(options: TestBackendOptions = {}): Promise<SumoTuiTestBackend> {
		const yoga = await loadYoga();
		return new SumoTuiTestBackend(yoga, {
			cols: normalizeDimension(options.cols ?? DEFAULT_COLS, DEFAULT_COLS),
			rows: normalizeDimension(options.rows ?? DEFAULT_ROWS, DEFAULT_ROWS),
		});
	}

	public get dimensions(): { cols: number; rows: number } {
		return { cols: this.cols, rows: this.rows };
	}

	public get current(): CellBuffer | undefined {
		return this.currentBuffer?.clone();
	}

	public get previous(): CellBuffer | undefined {
		return this.previousBuffer?.clone();
	}

	public get cursor(): HardwareCursor | null {
		return this.currentCursor ? { ...this.currentCursor } : null;
	}

	public setFocus(target: KeyTarget | undefined): void {
		this.keyRouter.setFocus(target);
	}

	public render(): TestBackendFrame {
		this.assertNotDisposed();
		this.root.width = this.cols;
		this.root.height = this.rows;
		this.root.yogaNode.calculateLayout(this.cols, this.rows, DIRECTION_LTR);

		const previous = this.currentBuffer?.clone();
		const current = new CellBuffer(this.rows, this.cols);
		const result = composite(this.root, current);

		this.previousBuffer = previous;
		this.currentBuffer = current.clone();
		this.currentCursor = result.hardwareCursor ? { ...result.hardwareCursor } : null;

		return {
			current: current.clone(),
			previous,
			cursor: this.cursor,
			cols: this.cols,
			rows: this.rows,
		};
	}

	public sendKey(event: string | KeyEvent): boolean {
		this.assertNotDisposed();
		return this.keyRouter.dispatch(event);
	}

	public sendMouse(event: MouseEvent): boolean {
		this.assertNotDisposed();
		return dispatchMouseEvent(this.root, event);
	}

	public resize(cols: number, rows: number): void {
		this.assertNotDisposed();
		this.cols = normalizeDimension(cols, this.cols);
		this.rows = normalizeDimension(rows, this.rows);
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.root.dispose();
		this.currentBuffer = undefined;
		this.previousBuffer = undefined;
		this.currentCursor = null;
	}

	private assertNotDisposed(): void {
		if (this.disposed) throw new Error("SumoTuiTestBackend has been disposed");
	}
}

export class SumoTuiPilot {
	public constructor(private readonly backend: SumoTuiTestBackend) {}

	public key(event: string | KeyEvent): boolean {
		const consumed = this.backend.sendKey(event);
		this.backend.render();
		return consumed;
	}

	public text(value: string): void {
		for (const char of value) this.key({ key: char, sequence: char });
	}

	public mouse(options: PilotMouseOptions): boolean {
		const consumed = this.backend.sendMouse({
			...options,
			modifiers: options.modifiers ?? DEFAULT_MOUSE_MODIFIERS,
		});
		this.backend.render();
		return consumed;
	}

	public resize(cols: number, rows: number): TestBackendFrame {
		this.backend.resize(cols, rows);
		return this.backend.render();
	}

	public render(): TestBackendFrame {
		return this.backend.render();
	}
}

function normalizeDimension(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}
