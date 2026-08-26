const TERMINAL_IO_ERROR_CODES = new Set([
	"EPIPE",
	"EIO",
	"ENOTTY",
	"EBADF",
	"ERR_STREAM_DESTROYED",
]);

function isErrorString(value: string | undefined): value is string {
	return typeof value === "string";
}

export function isTerminalIoError(cause: unknown): boolean {
	if (cause === null || cause === undefined) return false;
	// SAFETY: any thrown value may reach here; only the optional code/message
	// surface is read and both are validated by isErrorString before matching.
	const candidate = cause as { code?: string; message?: string };
	if (isErrorString(candidate.code) && TERMINAL_IO_ERROR_CODES.has(candidate.code)) return true;

	const message = isErrorString(candidate.message) ? candidate.message : "";
	return message === "Object has been destroyed"
		|| /\b(?:write|read) EIO\b/i.test(message)
		|| /\b(?:write|read) EPIPE\b/i.test(message)
		|| /\bsetRawMode ENOTTY\b/i.test(message);
}
