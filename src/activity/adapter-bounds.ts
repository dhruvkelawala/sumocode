import { safeValuePreview, sanitizeActivityText, type SafeValuePreviewOptions } from "./domain.js";

export interface AdapterTraversalBudget {
	remainingNodes: number;
	remainingChars: number;
}

export interface BoundedIndexedValue {
	readonly value: unknown;
	readonly originalIndex: number;
}

export function createAdapterTraversalBudget(options: { readonly maxNodes: number; readonly maxChars: number }): AdapterTraversalBudget {
	return {
		remainingNodes: Math.max(1, Math.floor(options.maxNodes)),
		remainingChars: Math.max(1, Math.floor(options.maxChars)),
	};
}

function claimNode(budget: AdapterTraversalBudget): boolean {
	if (budget.remainingNodes <= 0) return false;
	budget.remainingNodes -= 1;
	return true;
}

export function boundedRecord(value: unknown, budget: AdapterTraversalBudget): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || !claimNode(budget)) return undefined;
	return value as Record<string, unknown>;
}

/** Slice unknown arrays before any mapping and reserve one global traversal node. */
export function boundedArray(value: unknown, maxItems: number, budget: AdapterTraversalBudget): readonly unknown[] {
	if (!Array.isArray(value) || !claimNode(budget)) return [];
	return value.slice(0, Math.max(0, Math.floor(maxItems)));
}

/** Take the bounded tail when recent records carry the authoritative value. */
export function boundedArrayTail(value: unknown, maxItems: number, budget: AdapterTraversalBudget): readonly unknown[] {
	return boundedArrayTailWithIndices(value, maxItems, budget).map((entry) => entry.value);
}

/** Tail selection that preserves each value's absolute source index. */
export function boundedArrayTailWithIndices(
	value: unknown,
	maxItems: number,
	budget: AdapterTraversalBudget,
): readonly BoundedIndexedValue[] {
	if (!Array.isArray(value) || !claimNode(budget)) return [];
	const count = Math.max(0, Math.floor(maxItems));
	const start = Math.max(0, value.length - count);
	return count === 0 ? [] : value.slice(start).map((entry, index) => ({ value: entry, originalIndex: start + index }));
}

/**
 * Bound an event list without hiding live tail entries behind old settled work.
 * Preferred entries are returned first in source order (newest win if they
 * alone exceed the cap), followed by the newest settled entries. The original
 * index travels with every value so generated fallback IDs remain stable when
 * the selected window changes.
 */
export function boundedPriorityArray(
	value: unknown,
	maxItems: number,
	budget: AdapterTraversalBudget,
	isPreferred: (value: unknown) => boolean,
): readonly BoundedIndexedValue[] {
	if (!Array.isArray(value) || !claimNode(budget)) return [];
	const count = Math.max(0, Math.floor(maxItems));
	if (count === 0) return [];
	if (value.length <= count) return value.map((entry, originalIndex) => ({ value: entry, originalIndex }));

	// Inspect a fixed head plus a larger recent tail. The head preserves an old
	// long-running call; the tail finds current work and newest settled context.
	// Candidate storage and inspection are both bounded independently of the raw
	// producer array, which may be attacker-controlled or grow for a long run.
	const scanCount = count * 16;
	const headCount = Math.min(count, value.length);
	const tailStart = Math.max(headCount, value.length - Math.max(0, scanCount - headCount));
	const preferred: BoundedIndexedValue[] = [];
	const settled: BoundedIndexedValue[] = [];
	const inspect = (originalIndex: number): void => {
		const entry = { value: value[originalIndex], originalIndex };
		const candidates = isPreferred(entry.value) ? preferred : settled;
		candidates.push(entry);
		if (candidates.length > count) candidates.shift();
	};
	for (let originalIndex = 0; originalIndex < headCount; originalIndex += 1) inspect(originalIndex);
	for (let originalIndex = tailStart; originalIndex < value.length; originalIndex += 1) inspect(originalIndex);
	const remaining = count - preferred.length;
	const selectedSettled = remaining > 0 ? settled.slice(-remaining).reverse() : [];
	return [...preferred, ...selectedSettled];
}

/** Inspect only the remaining raw-character budget before sanitizing. */
export function boundedAdapterText(
	value: unknown,
	maxChars: number,
	budget: AdapterTraversalBudget,
): string | undefined {
	if (typeof value !== "string" || budget.remainingChars <= 0) return undefined;
	const outputMax = Math.max(1, Math.floor(maxChars));
	const inspectedChars = Math.min(value.length, outputMax, budget.remainingChars);
	budget.remainingChars -= inspectedChars;
	const sanitized = sanitizeActivityText(value.slice(0, inspectedChars));
	const truncated = value.length > inspectedChars || sanitized.length > outputMax;
	if (!truncated) return sanitized;
	return `${sanitized.slice(0, Math.max(0, outputMax - 1))}…`;
}

export function firstBoundedAdapterString(
	budget: AdapterTraversalBudget,
	maxChars: number,
	...values: unknown[]
): string | undefined {
	for (const value of values) {
		const text = boundedAdapterText(value, maxChars, budget)?.trim();
		if (text) return text;
	}
	return undefined;
}

/** Reserve per-preview work from the adapter's global node/character budgets. */
export function boundedAdapterPreview(
	value: unknown,
	budget: AdapterTraversalBudget,
	options: SafeValuePreviewOptions,
): string {
	if (budget.remainingChars <= 0 || budget.remainingNodes <= 0) return "[Truncated]";
	const requestedChars = Math.max(1, Math.floor(options.maxChars ?? 2_000));
	const requestedNodes = Math.max(1, Math.floor(options.maxNodes ?? 128));
	const maxChars = Math.max(1, Math.min(requestedChars, budget.remainingChars));
	const maxNodes = Math.max(1, Math.min(requestedNodes, budget.remainingNodes));
	budget.remainingChars = Math.max(0, budget.remainingChars - maxChars);
	budget.remainingNodes = Math.max(0, budget.remainingNodes - maxNodes);
	return safeValuePreview(value, {
		...options,
		maxChars,
		maxNodes,
		maxTotalStringChars: Math.min(options.maxTotalStringChars ?? maxChars, maxChars),
	});
}
