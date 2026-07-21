/**
 * pi-tui inserts a newline for shift+enter, which it only decodes reliably
 * from the CSI-u form. Legacy transports (herdr panes, plain terminals — no
 * kitty keyboard protocol) deliver modifier-Enter as `\x1b\r` (shift+enter
 * AND alt+enter — byte-identical), `\x1b\n` (Ghostty shift+enter), or `\n`
 * (ctrl+j, which pi-tui misparses as plain enter → submit). Rewriting these
 * to the CSI-u shift+enter sequence makes newline insertion deterministic and
 * kitty-flag-independent.
 *
 * The `\x1b\r` ambiguity is resolved in favor of NEWLINE: the follow-up
 * queue (app.message.followUp, Alt+Enter) stays reachable on kitty-native
 * transports where alt+enter arrives distinctly as `\x1b[13;3u`, and plain
 * Enter already queues while the agent is busy, so legacy transports lose
 * nothing they need.
 */
export const CSI_U_SHIFT_ENTER = "\x1b[13;2u";

/**
 * Returns how many newline presses `data` encodes, or 0 when it is not a
 * pure legacy modifier-Enter chunk. Callers must feed the editor ONE
 * CSI-u sequence per press — pi-tui parses input chunks as single keys, so
 * a concatenated multi-press string would be dropped.
 */
export function countLegacyModifierEnterPresses(data: string): number {
	if (data === "\n") return 1; // ctrl+j
	if (/^(?:\x1b[\r\n])+$/.test(data)) return data.length / 2;
	return 0;
}

export function normalizeRawMultilinePasteInput(data: string): string {
	// Bracketed paste is handled correctly by Pi's editor and should pass through.
	if (!data.includes("\r") || data.includes("\x1b[200~")) return data;
	// A single CR is an intentional submit. Multi-byte chunks containing CR are
	// paste-like (or terminal-batched) input; keep them in the draft by turning
	// raw CR/CRLF line breaks into editor newlines.
	if (data === "\r") return data;
	// Modifier-Enter encodings: pi-tui's editor recognizes `\x1b\r` as
	// shift+enter (kitty mapping) when kitty protocol is active, or alt+enter
	// when not. Rewriting the CR to LF here yields `\x1b\n`, which the editor
	// recognizes as neither — the keypress is silently dropped. Pass these
	// through verbatim so pi-tui can interpret them. Same applies to `\x1b\n`
	// (Ghostty's shift+enter encoding). The regex matches one or more
	// modifier-Enter encodings (defending against a hypothetical batched
	// `\x1b\r\x1b\r` chunk) and explicitly NOT a chunk that mixes
	// modifier-Enter with paste content — that case stays in the rewrite path
	// because the paste content is what we actually need to normalize.
	// CSI u modifier-Enter sequences such as `\x1b[13;2u` already do not
	// contain CR, so they are unaffected by the rewrite below.
	if (/^(?:\x1b[\r\n])+$/.test(data)) return data;
	return data.replace(/\r\n?/g, "\n");
}
