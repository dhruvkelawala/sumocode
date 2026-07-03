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
});
