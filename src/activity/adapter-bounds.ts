import { safeValuePreview, sanitizeActivityText, type SafeValuePreviewOptions } from "./domain.js";

export interface AdapterTraversalBudget {
	remainingNodes: number;
	remainingChars: number;
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
	if (!Array.isArray(value) || !claimNode(budget)) return [];
	const count = Math.max(0, Math.floor(maxItems));
	return count === 0 ? [] : value.slice(-count);
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
