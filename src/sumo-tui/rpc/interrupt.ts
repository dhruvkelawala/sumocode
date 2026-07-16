export type RpcInterruptInputKind = "ctrl-c" | "escape";

export type RpcInterruptDecision =
	| "dismiss-modal"
	| "clear-draft"
	| "abort"
	| "arm-quit"
	| "quit"
	| "pass";

export interface RpcInterruptState {
	readonly modalActive: boolean;
	readonly overlayActive: boolean;
	readonly draftNonEmpty: boolean;
	readonly isStreaming: boolean;
	readonly autocompleteOpen?: boolean;
	readonly armedUntil?: number;
	readonly now: number;
}

export function decideRpcInterrupt(
	input: RpcInterruptInputKind,
	state: RpcInterruptState,
): RpcInterruptDecision {
	if (state.modalActive || state.overlayActive) return "dismiss-modal";
	if (input === "escape") {
		// Mirrors pi's CustomEditor: Esc only triggers the app-level
		// interrupt/abort handler when the autocomplete dropdown is closed.
		// While it's open, Esc must reach the editor so it can close the
		// dropdown instead of aborting an in-flight stream.
		if (state.autocompleteOpen) return "pass";
		return state.isStreaming ? "abort" : "pass";
	}
	if (state.draftNonEmpty) return "clear-draft";
	if (state.isStreaming) return "abort";
	if (state.armedUntil !== undefined && state.now <= state.armedUntil) return "quit";
	return "arm-quit";
}
