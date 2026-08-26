import { describe, expect, it } from "vitest";
import { buildSessionTreeFromEntries, currentTreeSelection, flattenSessionTree, treeNodeSummary, type SessionTreeNode } from "./session-tree.js";
import type { SessionEntryLike } from "./session-reader.js";

function entry(id: string, parentId: string | null, overrides: Record<string, string | number | null> = {}): SessionEntryLike {
	// SAFETY: test fixtures only set the fields the tree builder reads.
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-08-04T00:00:${String(Number(overrides.order ?? 0)).padStart(2, "0")}.000Z`,
		message: { role: "user", content: id },
		...overrides,
	} as SessionEntryLike;
}

describe("iterative session tree projection", () => {
	it("flattens 6,001 linear entries without recursion or stack overflow", () => {
		const entries = Array.from({ length: 6_001 }, (_, index) => entry(`e-${index}`, index === 0 ? null : `e-${index - 1}`, { order: index % 60 }));
		const rows = flattenSessionTree(buildSessionTreeFromEntries(entries));
		expect(rows).toHaveLength(6_001);
	});

	it("keeps a linear chain at structural depth zero with no branch glyphs", () => {
		const rows = flattenSessionTree(buildSessionTreeFromEntries([entry("a", null), entry("b", "a"), entry("c", "b")]));
		expect(rows.map((row) => row.depth)).toEqual([0, 0, 0]);
		expect(rows.every((row) => !/[├└]/u.test(row.prefix))).toBe(true);
	});

	it("keeps branched siblings oldest-first with continuation glyphs", () => {
		const roots = buildSessionTreeFromEntries([
			entry("root", null),
			entry("new", "root", { order: 3 }),
			entry("old", "root", { order: 2 }),
		]);
		const rows = flattenSessionTree(roots);
		expect(rows.map((row) => row.node.entry.id)).toEqual(["root", "old", "new"]);
		expect(rows[1]?.prefix).toBe("├─ ");
		expect(rows[2]?.prefix).toBe("└─ ");
	});

	it("does not let hidden bookkeeping nodes consume a pending connector", () => {
		const roots = buildSessionTreeFromEntries([
			entry("root", null),
			{ ...entry("hidden", "root", { order: 1 }), type: "tool_result" },
			entry("visible", "hidden", { order: 2 }),
			entry("sibling", "root", { order: 3 }),
		]);
		const rows = flattenSessionTree(roots);
		expect(rows.map((row) => row.node.entry.id)).toEqual(["root", "visible", "sibling"]);
		expect(rows[1]?.prefix).toBe("├─ ");
	});

	it("preserves labels and explicit label clears", () => {
		const roots = buildSessionTreeFromEntries([
			entry("root", null),
			{ ...entry("label-1", "root"), type: "label", targetId: "root", label: "bookmark" },
			{ ...entry("label-2", "root"), type: "label", targetId: "root", label: null },
		]);
		expect(roots[0]?.label).toBeUndefined();
		expect(treeNodeSummary(roots[0]!)).toContain("root");
	});

	it("promotes orphaned and self-parented entries to roots", () => {
		const roots = buildSessionTreeFromEntries([entry("orphan", "missing"), entry("self", "self")]);
		expect(roots.map((node) => node.entry.id)).toEqual(["orphan", "self"]);
	});

	it("rejects duplicate IDs", () => {
		expect(() => buildSessionTreeFromEntries([entry("duplicate", null), entry("duplicate", null)])).toThrow(/duplicate/);
	});

	it("cuts a parent cycle at its earliest file-order member and visits every entry once", () => {
		const entries = [entry("first", "third"), entry("second", "first"), entry("third", "second"), entry("tail", "third")];
		const roots = buildSessionTreeFromEntries(entries);
		expect(roots.map((node) => node.entry.id)).toEqual(["first"]);
		const seen: string[] = [];
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			seen.push(node.entry.id);
			stack.push(...node.children);
		}
		expect(seen.sort()).toEqual(["first", "second", "tail", "third"].sort());
		expect(new Set(seen).size).toBe(entries.length);
	});

	it("uses the authoritative leaf and falls back to its nearest visible ancestor", () => {
		const roots = buildSessionTreeFromEntries([
			entry("root", null),
			{ ...entry("hidden", "root"), type: "tool_result" },
			entry("visible", "hidden"),
		]);
		expect(currentTreeSelection(roots, "visible")).toBe("visible");
		expect(currentTreeSelection(roots, "hidden")).toBe("root");
		expect(currentTreeSelection(roots, "missing")).toBeUndefined();
	});
});