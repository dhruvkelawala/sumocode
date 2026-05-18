const TERMINAL_IO_ERROR_CODES = new Set([
	"EPIPE",
	"EIO",
	"ENOTTY",
	"EBADF",
	"ERR_STREAM_DESTROYED",
]);

export function isTerminalIoError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
	if (typeof candidate.code === "string" && TERMINAL_IO_ERROR_CODES.has(candidate.code)) return true;

	const message = typeof candidate.message === "string" ? candidate.message : "";
	return message === "Object has been destroyed"
		|| /\b(?:write|read) EIO\b/i.test(message)
		|| /\b(?:write|read) EPIPE\b/i.test(message)
		|| /\bsetRawMode ENOTTY\b/i.test(message);
}
