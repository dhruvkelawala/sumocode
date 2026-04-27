import {
	EDGE_BOTTOM,
	EDGE_LEFT,
	EDGE_RIGHT,
	EDGE_TOP,
	POSITION_TYPE_ABSOLUTE,
	POSITION_TYPE_RELATIVE,
	POSITION_TYPE_STATIC,
	freeRecursive,
	type Align,
	type Edge,
	type FlexDirection,
	type Justify,
	type MeasureFunction,
	type PositionType,
	type YogaNode,
} from "./yoga.js";

export type SumoNodePosition = "absolute" | "relative" | "static" | PositionType;
export type SumoNodeSize = number | `${number}%`;

export interface SumoNodeEventHandlers {
	onMouseDown?: (node: SumoNode, event: unknown) => void;
	onMouseUp?: (node: SumoNode, event: unknown) => void;
	onMouseMove?: (node: SumoNode, event: unknown) => void;
	onScroll?: (node: SumoNode, event: unknown) => void;
}

function assertFiniteLayoutNumber(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.round(value));
}

function toPositionType(position: SumoNodePosition): PositionType {
	if (position === "absolute") return POSITION_TYPE_ABSOLUTE;
	if (position === "relative") return POSITION_TYPE_RELATIVE;
	if (position === "static") return POSITION_TYPE_STATIC;
	return position;
}

/**
 * Retained sumo-tui layout node. It owns one Yoga FFI node and mirrors the
 * JS-side child graph so renderer/compositor passes can walk without poking at
 * Yoga internals.
 */
export class SumoNode {
	public readonly yogaNode: YogaNode;
	public readonly eventHandlers: SumoNodeEventHandlers;
	public zIndex = 0;
	private parentNode: SumoNode | undefined;
	private readonly childNodes: SumoNode[] = [];
	private disposed = false;
	private hasMeasureFunction = false;

	public constructor(yogaNode: YogaNode, parent?: SumoNode, eventHandlers: SumoNodeEventHandlers = {}) {
		this.yogaNode = yogaNode;
		this.eventHandlers = eventHandlers;
		if (parent) parent.addChild(this);
	}

	public get parent(): SumoNode | undefined {
		return this.parentNode;
	}

	public get children(): readonly SumoNode[] {
		return this.childNodes;
	}

	public set width(value: SumoNodeSize) {
		this.yogaNode.setWidth(value);
	}

	public set height(value: SumoNodeSize) {
		this.yogaNode.setHeight(value);
	}

	public set flexGrow(value: number) {
		this.yogaNode.setFlexGrow(value);
	}

	public set flexShrink(value: number) {
		this.yogaNode.setFlexShrink(value);
	}

	public set flexDirection(value: FlexDirection) {
		this.yogaNode.setFlexDirection(value);
	}

	public set justifyContent(value: Justify) {
		this.yogaNode.setJustifyContent(value);
	}

	public set alignItems(value: Align) {
		this.yogaNode.setAlignItems(value);
	}

	public set paddingTop(value: number) {
		this.yogaNode.setPadding(EDGE_TOP, value);
	}

	public set paddingRight(value: number) {
		this.yogaNode.setPadding(EDGE_RIGHT, value);
	}

	public set paddingBottom(value: number) {
		this.yogaNode.setPadding(EDGE_BOTTOM, value);
	}

	public set paddingLeft(value: number) {
		this.yogaNode.setPadding(EDGE_LEFT, value);
	}

	public set marginTop(value: number) {
		this.yogaNode.setMargin(EDGE_TOP, value);
	}

	public set marginRight(value: number) {
		this.yogaNode.setMargin(EDGE_RIGHT, value);
	}

	public set marginBottom(value: number) {
		this.yogaNode.setMargin(EDGE_BOTTOM, value);
	}

	public set marginLeft(value: number) {
		this.yogaNode.setMargin(EDGE_LEFT, value);
	}

	public set position(value: SumoNodePosition) {
		this.yogaNode.setPositionType(toPositionType(value));
	}

	public set top(value: number) {
		this.yogaNode.setPosition(EDGE_TOP, value);
	}

	public set left(value: number) {
		this.yogaNode.setPosition(EDGE_LEFT, value);
	}

	public set right(value: number) {
		this.yogaNode.setPosition(EDGE_RIGHT, value);
	}

	public set bottom(value: number) {
		this.yogaNode.setPosition(EDGE_BOTTOM, value);
	}

	public addChild(node: SumoNode): void {
		this.assertNotDisposed();
		node.assertNotDisposed();
		if (node.parentNode === this) return;
		if (node.parentNode) node.parentNode.removeChild(node);
		node.parentNode = this;
		this.childNodes.push(node);
		this.yogaNode.insertChild(node.yogaNode, this.childNodes.length - 1);
	}

	public removeChild(node: SumoNode): void {
		const index = this.childNodes.indexOf(node);
		if (index === -1) return;
		this.childNodes.splice(index, 1);
		node.parentNode = undefined;
		this.yogaNode.removeChild(node.yogaNode);
	}

	public markDirty(): void {
		this.assertNotDisposed();
		// Yoga aborts if markDirty() is called on non-measured nodes. SumoNode is
		// public API, so make generic nodes a safe no-op while measured leaves can
		// still invalidate their cached dimensions.
		if (!this.hasMeasureFunction) return;
		this.yogaNode.markDirty();
	}

	public dispose(): void {
		if (this.disposed) return;
		if (this.parentNode) this.parentNode.removeChild(this);
		this.markWrapperDisposedRecursive();
		freeRecursive(this.yogaNode);
	}

	public getComputedTop(): number {
		return assertFiniteLayoutNumber(this.yogaNode.getComputedTop());
	}

	public getComputedLeft(): number {
		return assertFiniteLayoutNumber(this.yogaNode.getComputedLeft());
	}

	public getComputedWidth(): number {
		return assertFiniteLayoutNumber(this.yogaNode.getComputedWidth());
	}

	public getComputedHeight(): number {
		return assertFiniteLayoutNumber(this.yogaNode.getComputedHeight());
	}

	public getPositionType(): PositionType {
		return this.yogaNode.getPositionType();
	}

	protected setMeasureFunc(measureFunc: MeasureFunction | null): void {
		this.hasMeasureFunction = measureFunc !== null;
		this.yogaNode.setMeasureFunc(measureFunc);
	}

	protected assertNotDisposed(): void {
		if (this.disposed) throw new Error("SumoNode has been disposed");
	}

	private markWrapperDisposedRecursive(): void {
		this.disposed = true;
		for (const child of this.childNodes) {
			child.parentNode = undefined;
			child.markWrapperDisposedRecursive();
		}
		this.childNodes.length = 0;
		this.parentNode = undefined;
	}
}

export function edgeForSide(side: "top" | "right" | "bottom" | "left"): Edge {
	if (side === "top") return EDGE_TOP;
	if (side === "right") return EDGE_RIGHT;
	if (side === "bottom") return EDGE_BOTTOM;
	return EDGE_LEFT;
}
