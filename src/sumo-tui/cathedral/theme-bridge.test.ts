import { describe, expect, it } from "vitest";
import { emitCathedralThemeChanged, getCathedralThemeVersion, onCathedralThemeChanged } from "./theme-bridge.js";

describe("theme-bridge", () => {
	it("emits theme_changed and increments the repaint version", () => {
		const before = getCathedralThemeVersion();
		const seen: string[] = [];
		const unsubscribe = onCathedralThemeChanged((themeName) => seen.push(themeName));

		emitCathedralThemeChanged("amber-crt");
		unsubscribe();
		emitCathedralThemeChanged("obsidian-temple");

		expect(getCathedralThemeVersion()).toBe(before + 2);
		expect(seen).toEqual(["amber-crt"]);
	});
});
