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
	// (Ghostty's shift+enter encoding). CSI u modifier-Enter sequences such as
	// `\x1b[13;2u` already do not contain CR, so they are unaffected by the
	// rewrite below.
	if (data === "\x1b\r" || data === "\x1b\n") return data;
	return data.replace(/\r\n?/g, "\n");
}
