import { describe, expect, it } from "vitest";
import { Slate, SLATE_CUSTOM_TYPE } from "./slate.js";

describe("Slate", () => {
	it("starts empty", () => {
		const slate = new Slate();
		expect(slate.isEmpty).toBe(true);
		expect(slate.length).toBe(0);
		expect(slate.list()).toEqual([]);
	});

	it("adds items and returns the new count", () => {
		const slate = new Slate();
		expect(slate.add("fix cursor blink")).toBe(1);
		expect(slate.add("refactor sidebar")).toBe(2);
		expect(slate.list()).toEqual(["fix cursor blink", "refactor sidebar"]);
		expect(slate.length).toBe(2);
		expect(slate.isEmpty).toBe(false);
	});

	it("removes item at 1-based index", () => {
		const slate = new Slate();
		slate.add("A");
		slate.add("B");
		slate.add("C");

		expect(slate.remove(2)).toBe("B");
		expect(slate.list()).toEqual(["A", "C"]);
	});

	it("remove with no arg pops the first item", () => {
		const slate = new Slate();
		slate.add("first");
		slate.add("second");

		expect(slate.remove()).toBe("first");
		expect(slate.list()).toEqual(["second"]);
	});

	it("remove returns undefined for out-of-bounds index", () => {
		const slate = new Slate();
		slate.add("only");

		expect(slate.remove(0)).toBeUndefined();
		expect(slate.remove(5)).toBeUndefined();
		expect(slate.remove(-1)).toBeUndefined();
		expect(slate.list()).toEqual(["only"]);
	});

	it("pop removes and returns the first item", () => {
		const slate = new Slate();
		slate.add("A");
		slate.add("B");

		expect(slate.pop()).toBe("A");
		expect(slate.list()).toEqual(["B"]);
	});

	it("pop on empty slate returns undefined", () => {
		expect(new Slate().pop()).toBeUndefined();
	});

	it("clear removes all items and returns the count", () => {
		const slate = new Slate();
		slate.add("A");
		slate.add("B");
		slate.add("C");

		expect(slate.clear()).toBe(3);
		expect(slate.isEmpty).toBe(true);
		expect(slate.list()).toEqual([]);
	});

	it("clear on empty slate returns 0", () => {
		expect(new Slate().clear()).toBe(0);
	});
});

describe("Slate serialization", () => {
	it("toJSON returns a copy of the items array", () => {
		const slate = new Slate();
		slate.add("idea A");
		slate.add("idea B");

		const json = slate.toJSON();
		expect(json).toEqual({ items: ["idea A", "idea B"] });

		// Mutation of the returned object doesn't affect the slate
		json.items.push("should not appear");
		expect(slate.list()).toEqual(["idea A", "idea B"]);
	});

	it("fromEntries reconstructs from the latest slate entry", () => {
		const entries = [
			{ type: "custom", customType: SLATE_CUSTOM_TYPE, data: { items: ["old A", "old B"] } },
			{ type: "message", customType: "other" },
			{ type: "custom", customType: SLATE_CUSTOM_TYPE, data: { items: ["new A"] } },
		];

		const slate = Slate.fromEntries(entries);
		expect(slate.list()).toEqual(["new A"]);
	});

	it("fromEntries returns empty slate when no entries match", () => {
		const entries = [
			{ type: "message", customType: "other" },
			{ type: "custom", customType: "not-slate", data: { items: ["x"] } },
		];

		const slate = Slate.fromEntries(entries);
		expect(slate.isEmpty).toBe(true);
	});

	it("fromEntries ignores entries with missing or non-array items", () => {
		const entries = [
			{ type: "custom", customType: SLATE_CUSTOM_TYPE, data: {} },
			{ type: "custom", customType: SLATE_CUSTOM_TYPE, data: { items: "not-array" as unknown as string[] } },
		];

		const slate = Slate.fromEntries(entries);
		expect(slate.isEmpty).toBe(true);
	});

	it("round-trips through toJSON and fromEntries", () => {
		const original = new Slate();
		original.add("fix footer");
		original.add("refactor sidebar");
		original.add("investigate latency");

		const json = original.toJSON();
		const entry = { type: "custom", customType: SLATE_CUSTOM_TYPE, data: json };
		const restored = Slate.fromEntries([entry]);

		expect(restored.list()).toEqual(original.list());
	});
});

describe("Slate.formatForAgent", () => {
	it("formats empty slate", () => {
		expect(new Slate().formatForAgent()).toBe("The slate is empty. No parked ideas.");
	});

	it("formats numbered list", () => {
		const slate = new Slate();
		slate.add("fix cursor");
		slate.add("refactor sidebar");

		expect(slate.formatForAgent()).toBe("Slated items (2):\n1. fix cursor\n2. refactor sidebar");
	});
});
