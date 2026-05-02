export function normalizeRawMultilinePasteInput(data: string): string {
	// Bracketed paste is handled correctly by Pi's editor and should pass through.
	if (!data.includes("\r") || data.includes("\x1b[200~")) return data;
	// A single CR is an intentional submit. Multi-byte chunks containing CR are
	// paste-like (or terminal-batched) input; keep them in the draft by turning
	// raw CR/CRLF line breaks into editor newlines.
	if (data === "\r") return data;
	return data.replace(/\r\n?/g, "\n");
}
