import { collapseImagePathsForDisplay } from "../transcript/view-model.js";
import { isBackgroundTaskWakeMessage } from "../../background-tasks/task-types.js";
import type { SessionEntryLike, SessionEntryValue } from "./session-reader.js";

export interface SessionTreeNode {
	readonly entry: SessionEntryLike;
	readonly children: SessionTreeNode[];
	readonly label?: string;
	readonly labelTimestamp?: string;
}

export interface TreeRow {
	readonly node: SessionTreeNode;
	readonly depth: number;
	readonly prefix: string;
}

interface MutableNode {
	entry: SessionEntryLike;
	children: MutableNode[];
	label?: string;
	labelTimestamp?: string;
}

function timestampValue(value: string): number {
	const timestamp = new Date(value).getTime();
	return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function isEntryString(value: SessionEntryValue | undefined): value is string {
	return typeof value === "string";
}

function isTextBlock(block: SessionEntryValue): block is { type: "text"; text: string } {
	return typeof block === "object" && block !== null && !Array.isArray(block) && block["type"] === "text" && typeof block["text"] === "string";
}

/** Build the session tree from flat file-order entries without recursion. */
export function buildSessionTreeFromEntries(entries: readonly SessionEntryLike[]): SessionTreeNode[] {
	const nodeMap = new Map<string, MutableNode>();
	const fileOrder = new Map<string, number>();
	const labelsById = new Map<string, string>();
	const labelTimestampsById = new Map<string, string>();

	for (const [index, entry] of entries.entries()) {
		if (nodeMap.has(entry.id)) throw new Error(`duplicate session entry id: ${entry.id}`);
		fileOrder.set(entry.id, index);
		nodeMap.set(entry.id, { entry, children: [] });
		if (entry.type === "label") {
			const targetId = isEntryString(entry.targetId) ? entry.targetId : undefined;
			const label = isEntryString(entry.label) ? entry.label : undefined;
			if (targetId) {
				if (label) {
					labelsById.set(targetId, label);
					labelTimestampsById.set(targetId, entry.timestamp);
				} else {
					labelsById.delete(targetId);
					labelTimestampsById.delete(targetId);
				}
			}
		}
	}

	for (const node of nodeMap.values()) {
		node.label = labelsById.get(node.entry.id);
		node.labelTimestamp = labelTimestampsById.get(node.entry.id);
	}

	const parentById = new Map<string, string | null>();
	for (const entry of entries) {
		const parentId = entry.parentId;
		parentById.set(entry.id, parentId === null || parentId === entry.id || !nodeMap.has(parentId) ? null : parentId);
	}

	// Detect each parent cycle iteratively. The earliest file-order member is
	// promoted to a root, which removes exactly one edge and makes the whole
	// accepted graph traversable without revisiting a node.
	const completed = new Set<string>();
	for (const entry of entries) {
		if (completed.has(entry.id)) continue;
		const path: string[] = [];
		const pathIndex = new Map<string, number>();
		let current: string | null = entry.id;
		while (current !== null && !completed.has(current)) {
			const cycleStart = pathIndex.get(current);
			if (cycleStart !== undefined) {
				const cycle = path.slice(cycleStart);
				const promoted = cycle.reduce((earliest, id) => (fileOrder.get(id)! < fileOrder.get(earliest)! ? id : earliest), cycle[0]!);
				parentById.set(promoted, null);
				break;
			}
			pathIndex.set(current, path.length);
			path.push(current);
			current = parentById.get(current) ?? null;
		}
		for (const id of path) completed.add(id);
	}

	const roots: MutableNode[] = [];
	for (const entry of entries) {
		const node = nodeMap.get(entry.id)!;
		const parentId = parentById.get(entry.id) ?? null;
		if (parentId === null) roots.push(node);
		else nodeMap.get(parentId)!.children.push(node);
	}

	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		node.children.sort((left, right) => timestampValue(left.entry.timestamp) - timestampValue(right.entry.timestamp));
		for (const child of node.children) stack.push(child);
	}

	return roots;
}

export function treeEntryRoleAndText(entry: SessionEntryLike): { role: string; text: string } | undefined {
	// SAFETY: session entries are untyped JSON from Pi's own writer; the
	// message payload is validated field-by-field below.
	const message = entry.message as { role?: SessionEntryValue; content?: SessionEntryValue } | undefined;
	if (!message || !isEntryString(message.role)) return undefined;
	const content = message.content;
	const text = isEntryString(content)
		? content
		: Array.isArray(content)
			? content
				.filter(isTextBlock)
				.map((block) => block.text)
				.join(" ")
			: "";
	return text ? { role: message.role, text } : undefined;
}

export function isTreeNodeVisible(node: SessionTreeNode): boolean {
	if (node.label) return true;
	if (node.entry.type !== "message") return false;
	const extracted = treeEntryRoleAndText(node.entry);
	if (!extracted) return false;
	if (extracted.role === "user") return !isBackgroundTaskWakeMessage(extracted.text);
	return extracted.role === "assistant";
}

/**
 * Iterative equivalent of the previous recursive renderer. The return glyph
 * carried by a linear child is retained explicitly so filtered bookkeeping
 * nodes cannot consume a branch connector.
 */
export function flattenSessionTree(roots: readonly SessionTreeNode[]): TreeRow[] {
	const rows: TreeRow[] = [];
	type Frame = {
		node: SessionTreeNode;
		depth: number;
		indent: string;
		glyphIndent: string;
		glyph: string;
		phase: "enter" | "branch" | "linear";
		childIndex: number;
		result: string;
	};
	const stack: Frame[] = roots.map((node): Frame => ({ node, depth: 0, indent: "", glyphIndent: "", glyph: "", phase: "enter", childIndex: 0, result: "" })).reverse();
	const push = (node: SessionTreeNode, depth: number, indent: string, glyphIndent: string, glyph: string): void => {
		stack.push({ node, depth, indent, glyphIndent, glyph, phase: "enter", childIndex: 0, result: "" });
	};
	const returnToParent = (result: string): void => {
		stack.pop();
		const parent = stack[stack.length - 1];
		if (!parent) return;
		if (parent.phase === "linear") parent.result = result;
	};

	while (stack.length > 0) {
		const frame = stack[stack.length - 1]!;
		if (frame.phase === "enter") {
			if (isTreeNodeVisible(frame.node)) {
				rows.push({ node: frame.node, depth: frame.depth, prefix: frame.glyph ? `${frame.glyphIndent}${frame.glyph}` : frame.indent });
				frame.glyph = "";
			}
			if (frame.node.children.length > 1) {
				frame.phase = "branch";
				frame.childIndex = 0;
			} else if (frame.node.children.length === 1) {
				frame.phase = "linear";
				push(frame.node.children[0]!, frame.depth, frame.indent, frame.glyphIndent, frame.glyph);
				continue;
			} else {
				frame.result = frame.glyph;
				returnToParent(frame.result);
				continue;
			}
		}
		if (frame.phase === "linear") {
			returnToParent(frame.result);
			continue;
		}
		if (frame.phase === "branch") {
			if (frame.childIndex >= frame.node.children.length) {
				frame.result = frame.glyph;
				returnToParent(frame.result);
				continue;
			}
			const index = frame.childIndex;
			frame.childIndex += 1;
			const last = index === frame.node.children.length - 1;
			push(frame.node.children[index]!, frame.depth + 1, `${frame.indent}${last ? "   " : "│  "}`, frame.indent, last ? "└─ " : "├─ ");
		}
	}
	return rows;
}

export function treeNodeSummary(node: SessionTreeNode): string {
	const bookmark = node.label ? `[${node.label}] ` : "";
	const extracted = node.entry.type === "message" ? treeEntryRoleAndText(node.entry) : undefined;
	const glyph = extracted?.role === "user" ? "▷ " : extracted?.role === "assistant" ? "✦ " : "· ";
	const body = extracted ? sessionExcerpt(extracted.text, 68) : node.entry.type;
	return `${glyph}${bookmark}${body}`;
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
	if (Number.isNaN(date.getTime())) return "";
	const deltaMs = now.getTime() - date.getTime();
	if (deltaMs < 0) return date.toISOString().slice(0, 10);
	const minutes = Math.floor(deltaMs / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	return date.toISOString().slice(0, 10);
}

export function sessionExcerpt(text: string, maxLength: number): string {
	const cleaned = collapseImagePathsForDisplay(text)
		.replace(/<skill\s+name="([^"]+)"[^>]*>/gi, "/$1 ")
		.replace(/<\/skill>/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function treeRowTimestamp(entry: SessionEntryLike, now: Date = new Date()): string {
	return formatRelativeTime(new Date(entry.timestamp), now);
}

export function entryTimestampsFromEntries(entries: readonly SessionEntryLike[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of entries) {
		if (isEntryString(entry.id) && isEntryString(entry.timestamp)) map.set(entry.id, entry.timestamp);
	}
	return map;
}

export function currentTreeSelection(roots: readonly SessionTreeNode[], leafId: string | null): string | undefined {
	if (leafId === null) return undefined;
	const nodes = new Map<string, SessionTreeNode>();
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		nodes.set(node.entry.id, node);
		stack.push(...node.children);
	}
	const visible = new Set<string>();
	for (const node of nodes.values()) if (isTreeNodeVisible(node)) visible.add(node.entry.id);
	const seen = new Set<string>();
	let current: string | null = leafId;
	while (current !== null && !seen.has(current)) {
		seen.add(current);
		if (visible.has(current)) return current;
		current = nodes.get(current)?.entry.parentId ?? null;
	}
	return undefined;
}