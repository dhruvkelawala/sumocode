import { expect, it, vi } from "vitest";
import { captureProcessCensus } from "./process-tree.js";

const birth = "Mon Jun  1 12:00:00 2026";
const observer = `${process.pid} ${process.pid} ${birth} node test`;

it("returns a complete numeric census and only a nonce hint, never raw commands", () => {
	const nonce = "12345678-1234-1234-1234-123456789abc";
	const execute = vi.fn<() => string>().mockReturnValue(`${observer}\n42 42 ${birth} node anchor sumocode-retained-anchor:${nonce}\n43 42 ${birth} pi private-argument\n`);
	expect(captureProcessCensus(execute, "darwin")).toEqual([
		{ pid: process.pid, processGroupId: process.pid, processStartTime: birth },
		{ pid: 42, processGroupId: 42, processStartTime: birth, anchorNonce: nonce },
		{ pid: 43, processGroupId: 42, processStartTime: birth },
	]);
	expect(execute).toHaveBeenCalledExactlyOnceWith("/bin/ps", ["-axww", "-o", "pid=,pgid=,lstart=,command="], expect.objectContaining({ timeout: 5000, maxBuffer: 16 * 1024 * 1024 }));
});

it.each(["empty", "partial", "duplicate", "no-observer", "overflow", "error"])("treats %s enumeration as unknown", (fault) => {
	const output = fault === "empty" ? "" : fault === "partial" ? `${observer}\ntruncated` : fault === "duplicate" ? `${observer}\n${observer}`
		: fault === "no-observer" ? `42 42 ${birth} anchor` : `${observer}\n9007199254740992 42 ${birth} anchor`;
	const execute = vi.fn<() => string>().mockReturnValue(output);
	if (fault === "error") execute.mockImplementation(() => { throw new Error("EPERM"); });
	expect(captureProcessCensus(execute, "darwin")).toBeUndefined();
});
