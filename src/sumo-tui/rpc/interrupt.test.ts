import { describe, expect, it } from "vitest";
import { decideRpcInterrupt, type RpcInterruptState } from "./interrupt.js";

function state(overrides: Partial<RpcInterruptState> = {}): RpcInterruptState {
	return {
		modalActive: false,
		overlayActive: false,
		draftNonEmpty: false,
		isStreaming: false,
		now: 1_000,
		...overrides,
	};
}

describe("decideRpcInterrupt", () => {
	it("dismisses active modal or overlay before any other Ctrl-C outcome", () => {
		expect(decideRpcInterrupt("ctrl-c", state({ modalActive: true, draftNonEmpty: true, isStreaming: true }))).toBe("dismiss-modal");
		expect(decideRpcInterrupt("ctrl-c", state({ overlayActive: true, draftNonEmpty: true, isStreaming: true }))).toBe("dismiss-modal");
	});

	it("clears a non-empty draft before aborting or arming quit", () => {
		expect(decideRpcInterrupt("ctrl-c", state({ draftNonEmpty: true, isStreaming: true }))).toBe("clear-draft");
	});

	it("aborts streaming work when there is no modal or draft", () => {
		expect(decideRpcInterrupt("ctrl-c", state({ isStreaming: true }))).toBe("abort");
	});

	it("arms quit and turns a second Ctrl-C inside the window into quit", () => {
		expect(decideRpcInterrupt("ctrl-c", state())).toBe("arm-quit");
		expect(decideRpcInterrupt("ctrl-c", state({ armedUntil: 1_200 }))).toBe("quit");
		expect(decideRpcInterrupt("ctrl-c", state({ armedUntil: 999 }))).toBe("arm-quit");
	});

	it("maps Escape to modal dismissal, streaming abort, or pass-through", () => {
		expect(decideRpcInterrupt("escape", state({ modalActive: true }))).toBe("dismiss-modal");
		expect(decideRpcInterrupt("escape", state({ overlayActive: true }))).toBe("dismiss-modal");
		expect(decideRpcInterrupt("escape", state({ isStreaming: true }))).toBe("abort");
		expect(decideRpcInterrupt("escape", state({ draftNonEmpty: true }))).toBe("pass");
		expect(decideRpcInterrupt("escape", state())).toBe("pass");
	});

	it("passes Escape to the editor when the autocomplete dropdown is open, even while streaming", () => {
		expect(decideRpcInterrupt("escape", state({ isStreaming: true, autocompleteOpen: true }))).toBe("pass");
		expect(decideRpcInterrupt("escape", state({ isStreaming: false, autocompleteOpen: true }))).toBe("pass");
	});

	it("still dismisses a modal/overlay on Escape even when autocomplete is (implausibly) reported open", () => {
		expect(decideRpcInterrupt("escape", state({ modalActive: true, autocompleteOpen: true }))).toBe("dismiss-modal");
	});

	it("still aborts streaming on Escape when autocomplete is closed", () => {
		expect(decideRpcInterrupt("escape", state({ isStreaming: true, autocompleteOpen: false }))).toBe("abort");
	});

	// `app.clear` (Ctrl+C, declared in editor.ts's APP_KEYBINDING_DEFINITIONS)
	// is never wired via editor.onAction("app.clear", ...) -- confirmed by
	// grep -rn "\.onAction(" src/sumo-tui/rpc/ returning zero matches for it.
	// This is intentional, not a gap: shared-input-router.ts's
	// routeNonMouseInput gates on containsCtrlCToken BEFORE the editor ever
	// sees the input (`if (containsCtrlCToken(nextData) &&
	// this.callbacks.handlePreEditorInput?.(nextData) === true) return
	// { consume: true };`), and handlePreEditorInput (host.ts's
	// createRpcHostInterruptHandler) ultimately calls this exact
	// decideRpcInterrupt function with kind "ctrl-c". Every branch below
	// returns a real decision (dismiss-modal/clear-draft/abort/quit/arm-quit)
	// -- there is no state combination under which "ctrl-c" resolves to
	// "pass". So a raw Ctrl-C keypress can never fall through to
	// CustomEditor's actionHandlers loop: the router's interrupt tier always
	// consumes it first. Even in the hypothetical case this handler were
	// absent, runtime.ts's own handlePreEditorInput fallback
	// (`if (containsCtrlCToken(data)) { this.requestExit(130); return true; }`)
	// would still consume it before forwardToEditor. Wiring
	// editor.onAction("app.clear", ...) would install a second, unreachable
	// handler.
	it("never resolves Ctrl-C to pass-through -- the router's interrupt tier always consumes it before the editor (app.clear is dead-by-design)", () => {
		const allCtrlCOutcomes = [
			decideRpcInterrupt("ctrl-c", state({ modalActive: true })),
			decideRpcInterrupt("ctrl-c", state({ overlayActive: true })),
			decideRpcInterrupt("ctrl-c", state({ draftNonEmpty: true })),
			decideRpcInterrupt("ctrl-c", state({ isStreaming: true })),
			decideRpcInterrupt("ctrl-c", state({ armedUntil: 1_200 })),
			decideRpcInterrupt("ctrl-c", state({ armedUntil: 999 })),
			decideRpcInterrupt("ctrl-c", state()),
		];
		expect(allCtrlCOutcomes).not.toContain("pass");
	});
});
