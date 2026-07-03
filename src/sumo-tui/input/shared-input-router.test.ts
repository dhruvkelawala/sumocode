import { describe, expect, it, vi } from "vitest";
import { SharedInputRouter } from "./shared-input-router.js";

const CTRL_SLASH = "";

describe("SharedInputRouter — command palette vs. modal/overlay focus", () => {
	it("routes Ctrl+/ to a focused modal instead of opening the palette", () => {
		const openCommandPalette = vi.fn();
		const handleFocusedModalInput = vi.fn(() => true);
		const router = new SharedInputRouter({
			openCommandPalette,
			handleFocusedModalInput,
			handleFocusedOverlayInput: vi.fn(() => false),
		});

		const result = router.handleInput(CTRL_SLASH);

		expect(handleFocusedModalInput).toHaveBeenCalledWith(CTRL_SLASH);
		expect(openCommandPalette).not.toHaveBeenCalled();
		expect(result).toEqual({ consume: true });
	});

	it("routes Ctrl+/ to a focused overlay (e.g. an approval prompt) instead of opening the palette", () => {
		const openCommandPalette = vi.fn();
		// Simulate an approval overlay: it swallows input and does NOT resolve
		// its pending promise just because Ctrl+/ arrived.
		let overlayResolved = false;
		const approvalPromise = new Promise<string>((resolve) => {
			void resolve;
		}).then((value) => {
			overlayResolved = true;
			return value;
		});
		void approvalPromise;

		const handleFocusedOverlayInput = vi.fn(() => true);
		const router = new SharedInputRouter({
			openCommandPalette,
			handleFocusedModalInput: vi.fn(() => false),
			handleFocusedOverlayInput,
		});

		const result = router.handleInput(CTRL_SLASH);

		expect(handleFocusedOverlayInput).toHaveBeenCalledWith(CTRL_SLASH);
		expect(openCommandPalette).not.toHaveBeenCalled();
		expect(overlayResolved).toBe(false);
		expect(result).toEqual({ consume: true });
	});

	it("opens the palette on Ctrl+/ when neither a modal nor an overlay has focus", () => {
		const openCommandPalette = vi.fn();
		const router = new SharedInputRouter({
			openCommandPalette,
			handleFocusedModalInput: vi.fn(() => false),
			handleFocusedOverlayInput: vi.fn(() => false),
		});

		const result = router.handleInput(CTRL_SLASH);

		expect(openCommandPalette).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consume: true });
	});

	it("opens the palette on Ctrl+/ when no focus callbacks are wired at all (plain editor focus)", () => {
		const openCommandPalette = vi.fn();
		const router = new SharedInputRouter({ openCommandPalette });

		const result = router.handleInput(CTRL_SLASH);

		expect(openCommandPalette).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consume: true });
	});
});
