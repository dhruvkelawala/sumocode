import { describe, expect, it } from "vitest";
import { acquireCell, getCellPoolSize, releaseCell } from "./cell.js";

describe("cell pool", () => {
	it("recycles cell objects and resets style state (EC-9.3)", () => {
		const before = getCellPoolSize();
		const cell = acquireCell({ char: "x", fg: "#ff0000", attrs: { bold: true } });
		expect(cell.char).toBe("x");
		expect(cell.fg).toBe("#ff0000");
		expect(cell.attrs.bold).toBe(true);

		releaseCell(cell);
		expect(getCellPoolSize()).toBe(before + 1);

		const reused = acquireCell();
		expect(reused).toBe(cell);
		expect(reused.char).toBe(" ");
		expect(reused.fg).toBeUndefined();
		expect(reused.attrs.bold).toBe(false);
		releaseCell(reused);
	});
});
