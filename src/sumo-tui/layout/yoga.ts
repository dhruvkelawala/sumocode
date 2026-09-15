import YogaDefault, {
	Align,
	Direction,
	Edge,
	FlexDirection,
	Justify,
	MeasureMode,
	PositionType,
} from "yoga-layout";
import type { Node as YogaNode } from "yoga-layout";

/**
 * The upstream `Yoga` object type is not re-exported from the package root,
 * so derive it from the default export.
 */
export type Yoga = typeof YogaDefault;

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
} from "yoga-layout";

/**
 * Yoga 3 ships TypeScript enums (`Align.Center`) where the old binding shipped
 * SCREAMING_CASE constants. Yoga's own `YGEnums` default export carries this
 * table, but the package root only re-exports the enums, so the mapping lives
 * here. Importers keep using the constant names.
 */
export const ALIGN_AUTO = Align.Auto;
export const ALIGN_BASELINE = Align.Baseline;
export const ALIGN_CENTER = Align.Center;
export const ALIGN_FLEX_END = Align.FlexEnd;
export const ALIGN_FLEX_START = Align.FlexStart;
export const ALIGN_SPACE_AROUND = Align.SpaceAround;
export const ALIGN_SPACE_BETWEEN = Align.SpaceBetween;
export const ALIGN_STRETCH = Align.Stretch;
export const DIRECTION_INHERIT = Direction.Inherit;
export const DIRECTION_LTR = Direction.LTR;
export const DIRECTION_RTL = Direction.RTL;
export const EDGE_ALL = Edge.All;
export const EDGE_BOTTOM = Edge.Bottom;
export const EDGE_END = Edge.End;
export const EDGE_HORIZONTAL = Edge.Horizontal;
export const EDGE_LEFT = Edge.Left;
export const EDGE_RIGHT = Edge.Right;
export const EDGE_START = Edge.Start;
export const EDGE_TOP = Edge.Top;
export const EDGE_VERTICAL = Edge.Vertical;
export const FLEX_DIRECTION_COLUMN = FlexDirection.Column;
export const FLEX_DIRECTION_COLUMN_REVERSE = FlexDirection.ColumnReverse;
export const FLEX_DIRECTION_ROW = FlexDirection.Row;
export const FLEX_DIRECTION_ROW_REVERSE = FlexDirection.RowReverse;
export const JUSTIFY_CENTER = Justify.Center;
export const JUSTIFY_FLEX_END = Justify.FlexEnd;
export const JUSTIFY_FLEX_START = Justify.FlexStart;
export const JUSTIFY_SPACE_AROUND = Justify.SpaceAround;
export const JUSTIFY_SPACE_BETWEEN = Justify.SpaceBetween;
export const JUSTIFY_SPACE_EVENLY = Justify.SpaceEvenly;
export const MEASURE_MODE_AT_MOST = MeasureMode.AtMost;
export const MEASURE_MODE_EXACTLY = MeasureMode.Exactly;
export const MEASURE_MODE_UNDEFINED = MeasureMode.Undefined;
export const POSITION_TYPE_ABSOLUTE = PositionType.Absolute;
export const POSITION_TYPE_RELATIVE = PositionType.Relative;
export const POSITION_TYPE_STATIC = PositionType.Static;

export type SumoYogaNode = YogaNode;
export type SumoYoga = Yoga;
export type SumoYogaEdge = Edge;
export type SumoYogaFlexDirection = FlexDirection;
export type SumoYogaJustify = Justify;
export type SumoYogaAlign = Align;
export type SumoYogaPositionType = PositionType;
export type SumoYogaMeasureMode = MeasureMode;

const yogaPromise: Promise<Yoga> = Promise.resolve(YogaDefault);

/**
 * Share one initialized Yoga module across the renderer.
 *
 * Source note: `yoga-layout` v3 (Meta's official binding) embeds its WASM as
 * base64 inside JS and initializes it with a top-level await, so the module is
 * ready by the time this file finishes evaluating — no sidecar `.wasm` asset
 * and no runtime file read. The promise wrapper is kept so every caller keeps
 * the same async seam it had under the previous binding.
 */
export function loadYoga(): Promise<Yoga> {
	return yogaPromise;
}

/**
 * Free a Yoga node and all descendants without relying on the binding's
 * built-in `freeRecursive()`. Walking children ourselves makes leak tests able
 * to mock the FFI surface and verifies Edge Case 9.2 explicitly.
 *
 * Embind may hand back a fresh JS wrapper for the same underlying node on each
 * `getChild()` call (yoga upstream #1858), so this must never compare node
 * identity — `removeChild`/`free` route through the native pointer instead.
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
