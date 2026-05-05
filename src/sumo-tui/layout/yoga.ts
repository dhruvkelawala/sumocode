import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initYoga from "yoga-wasm-web";
import type {
	Align,
	Edge,
	FlexDirection,
	Justify,
	MeasureMode,
	Node as YogaNode,
	PositionType,
	Yoga,
} from "yoga-wasm-web";

export type {
	Align,
	Direction,
	Edge,
	FlexDirection,
	Justify,
	MeasureFunction,
	MeasureMode,
	Node as YogaNode,
	PositionType,
	Yoga,
} from "yoga-wasm-web";

export {
	ALIGN_AUTO,
	ALIGN_BASELINE,
	ALIGN_CENTER,
	ALIGN_FLEX_END,
	ALIGN_FLEX_START,
	ALIGN_SPACE_AROUND,
	ALIGN_SPACE_BETWEEN,
	ALIGN_STRETCH,
	DIRECTION_INHERIT,
	DIRECTION_LTR,
	DIRECTION_RTL,
	EDGE_ALL,
	EDGE_BOTTOM,
	EDGE_END,
	EDGE_HORIZONTAL,
	EDGE_LEFT,
	EDGE_RIGHT,
	EDGE_START,
	EDGE_TOP,
	EDGE_VERTICAL,
	FLEX_DIRECTION_COLUMN,
	FLEX_DIRECTION_COLUMN_REVERSE,
	FLEX_DIRECTION_ROW,
	FLEX_DIRECTION_ROW_REVERSE,
	JUSTIFY_CENTER,
	JUSTIFY_FLEX_END,
	JUSTIFY_FLEX_START,
	JUSTIFY_SPACE_AROUND,
	JUSTIFY_SPACE_BETWEEN,
	JUSTIFY_SPACE_EVENLY,
	MEASURE_MODE_AT_MOST,
	MEASURE_MODE_EXACTLY,
	MEASURE_MODE_UNDEFINED,
	POSITION_TYPE_ABSOLUTE,
	POSITION_TYPE_RELATIVE,
	POSITION_TYPE_STATIC,
} from "yoga-wasm-web";

export type SumoYogaNode = YogaNode;
export type SumoYoga = Yoga;
export type SumoYogaEdge = Edge;
export type SumoYogaFlexDirection = FlexDirection;
export type SumoYogaJustify = Justify;
export type SumoYogaAlign = Align;
export type SumoYogaPositionType = PositionType;
export type SumoYogaMeasureMode = MeasureMode;

let yogaPromise: Promise<Yoga> | undefined;

/**
 * Load `yoga-wasm-web` once and share the WASM module across the renderer.
 *
 * Source note: Phase 2 deliberately uses `yoga-wasm-web` (pure WASM, no native
 * build step) per the issue's Edge Case 11.1 gate. The package's default export
 * is async, so this caches the initialized module on first use.
 */
export function loadYoga(): Promise<Yoga> {
	if (!yogaPromise) {
		const require = createRequire(import.meta.url);
		const wasmPath = require.resolve("yoga-wasm-web/dist/yoga.wasm");
		yogaPromise = readFile(wasmPath).then((wasm) => initYoga(wasm));
	}
	return yogaPromise;
}

// Pre-warm Yoga during module evaluation. SumoTUI always needs layout, so
// starting the WASM read/compile here overlaps it with the rest of startup.
// Attach a rejection handler now so a missing/unreadable WASM file is still
// surfaced by the later awaited loadYoga() call instead of as an unhandled
// fire-and-forget rejection during module import.
void loadYoga().catch(() => undefined);

/**
 * Free a Yoga node and all descendants without relying on the binding's
 * built-in `freeRecursive()`. Walking children ourselves makes leak tests able
 * to mock the FFI surface and verifies Edge Case 9.2 explicitly.
 */
export function freeRecursive(node: YogaNode): void {
	const children: YogaNode[] = [];
	for (let index = 0; index < node.getChildCount(); index += 1) {
		children.push(node.getChild(index));
	}

	for (const child of children) {
		node.removeChild(child);
		freeRecursive(child);
	}

	node.free();
}
