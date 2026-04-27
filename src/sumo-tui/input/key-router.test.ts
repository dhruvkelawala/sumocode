import { describe, expect, it, vi } from "vitest";
import { KeyRouter, type KeyTarget } from "./key-router.js";

describe("KeyRouter", () => {
	it("dispatches to the focused component before global bindings", () => {
		const router = new KeyRouter();
		const global = vi.fn(() => true);
		const focused: KeyTarget = { handleKey: vi.fn(() => true) };
		router.bind("PageUp", global);
		router.setFocus(focused);

		expect(router.dispatch("PageUp")).toBe(true);
		expect(focused.handleKey).toHaveBeenCalledWith({ key: "PageUp" });
		expect(global).not.toHaveBeenCalled();
	});

	it("falls back to bindings and unbinds keys", () => {
		const router = new KeyRouter();
		const handler = vi.fn(() => true);
		const unbind = router.bind("End", handler);

		expect(router.dispatch({ key: "End" })).toBe(true);
		unbind();
		expect(router.dispatch({ key: "End" })).toBe(false);
	});
});
