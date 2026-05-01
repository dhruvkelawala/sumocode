import { describe, expect, it } from "vitest";
import {
	renderDivineQuery,
	updateDivineQuery,
	type DivineQuerySnapshot,
} from "./divine-query.js";

const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function snapshot(overrides: Partial<DivineQuerySnapshot> = {}): DivineQuerySnapshot {
	return {
		title: "Should I rename `getUser` to `fetchUser`?",
		options: ["Yes, rename it everywhere", "No, leave it as-is", "Use a different name"],
		focusedIndex: 0,
		...overrides,
	};
}

describe("renderDivineQuery", () => {
	it("frames the modal with rounded corners and side bars", () => {
		const lines = renderDivineQuery(snapshot(), 80);
		const plain = lines.map(stripAnsi);

		// Top border: ╭───…───╮
		expect(plain[0]?.startsWith("╭")).toBe(true);
		expect(plain[0]?.endsWith("╮")).toBe(true);
		expect(plain[0]?.length).toBe(80);

		// Bottom border: ╰───…───╯
		const last = plain.at(-1)!;
		expect(last.startsWith("╰")).toBe(true);
		expect(last.endsWith("╯")).toBe(true);
		expect(last.length).toBe(80);

		// Every body row sits inside `│ … │`
		for (let i = 1; i < plain.length - 1; i += 1) {
			const row = plain[i]!;
			expect(row.startsWith("│"), `row ${i} missing left border: ${JSON.stringify(row)}`).toBe(true);
			expect(row.endsWith("│"), `row ${i} missing right border: ${JSON.stringify(row)}`).toBe(true);
			expect(row.length, `row ${i} not padded: ${row.length}`).toBe(80);
		}
	});

	it("renders ✾ DIVINE QUERY ✾ title in accent inside the frame", () => {
		const lines = renderDivineQuery(snapshot(), 80);
		const titleLine = lines.find((l) => stripAnsi(l).includes("DIVINE QUERY"));
		expect(titleLine).toBeDefined();
		// accent #D97706 -> 217;119;6
		expect(titleLine).toContain("[38;2;217;119;6m");
		expect(stripAnsi(titleLine!)).toContain("✾  DIVINE QUERY  ✾");
		// Title row is bordered, not free-floating
		expect(stripAnsi(titleLine!).startsWith("│")).toBe(true);
		expect(stripAnsi(titleLine!).endsWith("│")).toBe(true);
	});

	it("renders decorative split rules in divider — distinct from frame borders", () => {
		const lines = renderDivineQuery(snapshot(), 80).map(stripAnsi);
		// Inner decorative rules contain `·`; frame borders never do.
		const ruleLines = lines.filter((l) => l.includes("·") && l.includes("──"));
		expect(ruleLines.length).toBe(2); // top + bottom inner rules
	});

	it("renders question body in foreground inside the frame", () => {
		const lines = renderDivineQuery(snapshot(), 80);
		const bodyLine = lines.find((l) => stripAnsi(l).includes("rename"));
		expect(bodyLine).toBeDefined();
		// foreground #F5E6C8 -> 245;230;200
		expect(bodyLine).toContain("[38;2;245;230;200m");
		expect(stripAnsi(bodyLine!).startsWith("│")).toBe(true);
	});

	it("renders focused option with ❈ in accent and text in foreground", () => {
		const lines = renderDivineQuery(snapshot({ focusedIndex: 0 }), 80);
		const focusedLine = lines.find((l) => stripAnsi(l).includes("❈"));
		expect(focusedLine).toBeDefined();
		expect(stripAnsi(focusedLine!)).toContain("A) Yes, rename it everywhere");
		expect(focusedLine).toContain("[38;2;217;119;6m❈"); // accent
	});

	it("renders unfocused options with · in divider and text in dim", () => {
		const lines = renderDivineQuery(snapshot({ focusedIndex: 0 }), 80);
		const plain = lines.map(stripAnsi);
		const bLine = plain.find((l) => l.includes("B) No"));
		expect(bLine).toContain("·");
		// Check dim color on the raw ANSI
		const rawB = lines.find((l) => stripAnsi(l).includes("B) No"));
		expect(rawB).toContain("[38;2;139;122;99m"); // foregroundDim
	});

	it("renders footer with wander/answer/retreat", () => {
		const lines = renderDivineQuery(snapshot(), 80).map(stripAnsi);
		const footer = lines.find((l) => l.includes("wander"));
		expect(footer).toContain("↑↓ wander");
		expect(footer).toContain("⏎ answer");
		expect(footer).toContain("⎋ retreat");
		// Footer also lives inside the frame
		expect(footer!.startsWith("│")).toBe(true);
		expect(footer!.endsWith("│")).toBe(true);
	});

	it("renders surfaceLifted background on every row including borders", () => {
		const lines = renderDivineQuery(snapshot(), 80);
		// surfaceLifted #3D3024 -> 61;48;36
		for (const line of lines) {
			expect(line).toContain("[48;2;61;48;36m");
		}
	});

	it("pads every row — including borders — to exactly the requested width", () => {
		const lines = renderDivineQuery(snapshot(), 80);
		for (const line of lines) {
			expect(stripAnsi(line).length, `row not padded: ${JSON.stringify(stripAnsi(line))}`).toBe(80);
		}
	});

	it("wraps long question and option text inside the inner frame width", () => {
		const lines = renderDivineQuery(snapshot({
			title: "Divine Query smoke test: which modal behavior should we verify next, and why does this text need to stay inside the modal frame?",
			options: ["Type a very long custom answer option that should never run past the lifted surface edge"],
		}), 50);
		const plain = lines.map(stripAnsi);

		for (const line of plain) {
			expect(line.length, `row overflowed: ${JSON.stringify(line)}`).toBe(50);
			// Body rows stay inside the frame
			if (!line.startsWith("╭") && !line.startsWith("╰")) {
				expect(line.startsWith("│"), `row not framed: ${JSON.stringify(line)}`).toBe(true);
				expect(line.endsWith("│"), `row not framed: ${JSON.stringify(line)}`).toBe(true);
			}
		}
		expect(plain.filter((line) => line.includes("Divine Query smoke test")).length).toBe(1);
		// The full title text should still be reconstructible by joining the
		// stripped/trimmed body rows back together (just check the tail phrase).
		expect(plain.some((line) => line.includes("frame?"))).toBe(true);
	});

	it("appends extras between footer and bottom border, framed in the same modal", () => {
		const lines = renderDivineQuery(snapshot(), 60, {
			extras: ["     Your answer:", "     hello world"],
		});
		const plain = lines.map(stripAnsi);

		const helloRow = plain.find((line) => line.includes("hello world"));
		expect(helloRow).toBeDefined();
		expect(helloRow!.startsWith("│")).toBe(true);
		expect(helloRow!.endsWith("│")).toBe(true);
		expect(helloRow!.length).toBe(60);

		// Bottom border still lives at the very last row, after the extras
		expect(plain.at(-1)!.startsWith("╰")).toBe(true);
		const helloIndex = plain.findIndex((line) => line.includes("hello world"));
		expect(helloIndex).toBeLessThan(plain.length - 1);
	});

	it("labels options with A), B), C), etc.", () => {
		const lines = renderDivineQuery(snapshot(), 80).map(stripAnsi);
		expect(lines.some((l) => l.includes("A)"))).toBe(true);
		expect(lines.some((l) => l.includes("B)"))).toBe(true);
		expect(lines.some((l) => l.includes("C)"))).toBe(true);
	});

	it("renders empty array at widths < 4 (frame would not fit)", () => {
		expect(renderDivineQuery(snapshot(), 0)).toEqual([]);
		expect(renderDivineQuery(snapshot(), 3)).toEqual([]);
	});
});

describe("updateDivineQuery — direct letter selection", () => {
	it("a/A selects first option", () => {
		expect(updateDivineQuery(snapshot(), "a").done).toBe(0);
		expect(updateDivineQuery(snapshot(), "A").done).toBe(0);
	});

	it("b selects second option", () => {
		expect(updateDivineQuery(snapshot(), "b").done).toBe(1);
	});

	it("ignores letters beyond the option count", () => {
		expect(updateDivineQuery(snapshot(), "d").done).toBeUndefined();
	});
});

describe("updateDivineQuery — arrow/tab navigation", () => {
	it("down cycles focused index forward", () => {
		const r1 = updateDivineQuery(snapshot({ focusedIndex: 0 }), "down");
		expect(r1.snapshot.focusedIndex).toBe(1);
		const r2 = updateDivineQuery(snapshot({ focusedIndex: 2 }), "down");
		expect(r2.snapshot.focusedIndex).toBe(0); // wraps
	});

	it("up cycles backward", () => {
		const r = updateDivineQuery(snapshot({ focusedIndex: 0 }), "up");
		expect(r.snapshot.focusedIndex).toBe(2); // wraps
	});

	it("j/k also navigate", () => {
		expect(updateDivineQuery(snapshot({ focusedIndex: 0 }), "j").snapshot.focusedIndex).toBe(1);
		expect(updateDivineQuery(snapshot({ focusedIndex: 1 }), "k").snapshot.focusedIndex).toBe(0);
	});
});

describe("updateDivineQuery — enter + escape", () => {
	it("enter selects the focused option", () => {
		const r = updateDivineQuery(snapshot({ focusedIndex: 2 }), "enter");
		expect(r.done).toBe(2);
	});

	it("escape returns -1 (retreat)", () => {
		const r = updateDivineQuery(snapshot(), "escape");
		expect(r.done).toBe(-1);
	});
});
