import { describe, expect, it } from "vitest";
import {
	INPUT_FRAME_HINT_KEYBINDS,
	INPUT_FRAME_HINT_AWAITING,
	renderInputFrame,
	renderInputHints,
} from "./input-frame.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

describe("renderInputFrame — active state (no label, no placeholder)", () => {
	it("renders 3 rows: top + content + bottom", () => {
		const lines = renderInputFrame("hello", 50);
		expect(lines.length).toBe(3);
		expect(lines[0]).toMatch(/┌.+┐/);
		expect(lines[2]).toMatch(/└.+┘/);
	});

	it("renders an unlabeled top border by default", () => {
		const top = stripAnsi(renderInputFrame("hello", 50)[0]!);
		expect(top).toBe(`┌${"─".repeat(48)}┐`);
		expect(top).not.toContain("INPUT");
	});

	it("renders prompt arrow > before input text on the content row", () => {
		const lines = renderInputFrame("hello", 50).map(stripAnsi);
		expect(lines[1]).toContain("> hello");
	});

	it("renders cursor █ at end of text", () => {
		const lines = renderInputFrame("hello", 50).map(stripAnsi);
		expect(lines[1]).toContain("> hello█");
	});

	it("pads each line to exact width", () => {
		const width = 60;
		const lines = renderInputFrame("test", width);
		for (const line of lines) {
			expect(stripAnsi(line).length).toBe(width);
		}
	});

	it("colors frame chars in divider color (#3A2F25)", () => {
		const lines = renderInputFrame("hi", 40);
		// divider #3A2F25 -> 58;47;37
		expect(lines.join("\n")).toContain("\u001b[38;2;58;47;37m");
	});

	it("colors cursor █ in accent (#D97706)", () => {
		const lines = renderInputFrame("test", 40);
		// accent #D97706 -> 217;119;6
		expect(lines.join("\n")).toContain("\u001b[38;2;217;119;6m");
	});

	it("paints the inner content with the recess background (#120D0A)", () => {
		const lines = renderInputFrame("hi", 40);
		// recess #120D0A -> 18;13;10 as bg = 48;2;18;13;10
		expect(lines.join("\n")).toContain("\u001b[48;2;18;13;10m");
	});

	it("defaults `>` prompt to oxidized (#8B7A63), not accent", () => {
		const lines = renderInputFrame("hello", 50);
		// oxidized #8B7A63 -> 139;122;99
		expect(lines.join("\n")).toContain("\u001b[38;2;139;122;99m>");
	});

	it("colors `>` accent when promptColor: 'accent' is set", () => {
		const lines = renderInputFrame("hello", 50, { promptColor: "accent" });
		expect(lines.join("\n")).toContain("\u001b[38;2;217;119;6m>");
	});
});

describe("renderInputFrame — splash state (with label + placeholder)", () => {
	it("renders top border with label `┌─ DIVINE INVOCATION ──...─┐`", () => {
		const lines = renderInputFrame("", 60, { label: "DIVINE INVOCATION" });
		const top = stripAnsi(lines[0]!);
		expect(top).toMatch(/^┌.* DIVINE INVOCATION /);
		expect(top).toMatch(/┐$/);
	});

	it("shows placeholder text when input is empty on the content row", () => {
		const lines = renderInputFrame("", 80, {
			placeholder: 'Ask anything... "Refactor the auth flow."',
		});
		const content = stripAnsi(lines[1]!);
		expect(content).toContain("Ask anything");
		expect(content).toContain("Refactor the auth flow.");
	});

	it("hides placeholder once input is non-empty", () => {
		const lines = renderInputFrame("hello", 80, {
			placeholder: "should not appear",
		});
		const content = stripAnsi(lines[1]!);
		expect(content).not.toContain("should not appear");
		expect(content).toContain("> hello");
	});

	it("placeholder text uses foregroundDim without ANSI DIM", () => {
		const lines = renderInputFrame("", 80, {
			placeholder: "Ask anything",
		});
		const output = lines.join("\n");
		expect(output).toContain("\u001b[38;2;139;122;99m");
		expect(output).not.toContain("\u001b[2m");
	});
});

describe("renderInputHints", () => {
	it("returns a single-line right-aligned command hint by default", () => {
		const line = renderInputHints(80);
		const plain = stripAnsi(line);
		expect(plain.length).toBe(80);
		expect(plain).toContain(INPUT_FRAME_HINT_KEYBINDS);
		expect(plain).not.toContain("AGENTS");
		// Right-aligned: keybinds at the end
		expect(plain.trimEnd().endsWith(INPUT_FRAME_HINT_KEYBINDS)).toBe(true);
	});

	it("renders both hints when leftHint provided (splash style)", () => {
		const line = renderInputHints(80, { leftHint: INPUT_FRAME_HINT_AWAITING });
		const plain = stripAnsi(line);
		expect(plain).toContain(INPUT_FRAME_HINT_AWAITING);
		expect(plain).toContain(INPUT_FRAME_HINT_KEYBINDS);
		// Left hint comes before right hint
		expect(plain.indexOf(INPUT_FRAME_HINT_AWAITING)).toBeLessThan(plain.indexOf(INPUT_FRAME_HINT_KEYBINDS));
	});

	it("hints use foregroundDim", () => {
		const line = renderInputHints(80, { leftHint: INPUT_FRAME_HINT_AWAITING });
		// foregroundDim #8B7A63 -> 139;122;99
		expect(line).toContain("\u001b[38;2;139;122;99m");
	});

	it("at narrow width, drops left hint first", () => {
		// Only enough room for keybinds
		const line = stripAnsi(renderInputHints(30, { leftHint: INPUT_FRAME_HINT_AWAITING }));
		expect(line).toContain(INPUT_FRAME_HINT_KEYBINDS);
		expect(line).not.toContain("AWAITING");
	});

	it("colors CTRL+/ modifier key in accent (#D97706)", () => {
		const line = renderInputHints(80);
		expect(line).not.toContain("TAB");
		expect(line).not.toContain("AGENTS");
		expect(line).toContain("\u001b[38;2;217;119;6mCTRL+/");
	});

	it("at very narrow width, returns minimal/empty", () => {
		const line = renderInputHints(15);
		expect(stripAnsi(line).length).toBeLessThanOrEqual(15);
	});
});

describe("INPUT_FRAME_HINT_KEYBINDS / INPUT_FRAME_HINT_AWAITING constants", () => {
	it("exposes locked keybind hint string", () => {
		expect(INPUT_FRAME_HINT_KEYBINDS).toBe("CTRL+/ · COMMANDS");
	});

	it("exposes locked awaiting hint string", () => {
		expect(INPUT_FRAME_HINT_AWAITING).toBe("╰─ AWAITING PROMPT");
	});
});
