import { describe, expect, it } from "vitest";
import { isTerminalIoError } from "./terminal-errors.js";

describe("isTerminalIoError", () => {
	it.each(["EPIPE", "EIO", "ENOTTY", "EBADF", "ERR_STREAM_DESTROYED"])("matches terminal error code %s", (code) => {
		const error = new Error(code) as NodeJS.ErrnoException;
		error.code = code;
		expect(isTerminalIoError(error)).toBe(true);
	});

	it.each([
		"write EIO",
		"read EIO",
		"write EPIPE",
		"setRawMode ENOTTY",
		"Object has been destroyed",
	])("matches terminal-gone message %s", (message) => {
		expect(isTerminalIoError(new Error(message))).toBe(true);
	});

	it("does not hide non-terminal errors", () => {
		expect(isTerminalIoError(new Error("ERR_MODULE_NOT_FOUND @dhruvkelawala/sumocode"))).toBe(false);
		expect(isTerminalIoError({ code: "ERR_MODULE_NOT_FOUND" })).toBe(false);
		expect(isTerminalIoError("write EIO")).toBe(false);
	});
});
