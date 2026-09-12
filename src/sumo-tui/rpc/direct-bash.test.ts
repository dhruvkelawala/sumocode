import { describe, expect, it, vi } from "vitest";
import { DirectBashController, parseDirectBash } from "./direct-bash.js";

describe("parseDirectBash", () => {
	it.each([
		["!echo hi", { command: "echo hi", excludeFromContext: false }],
		["!! echo hi  ", { command: "echo hi  ", excludeFromContext: true }],
		["!  echo hi", { command: " echo hi", excludeFromContext: false }],
	])("parses %j without changing the command body", (input, expected) => {
		expect(parseDirectBash(input)).toEqual(expected);
	});

	it.each(["hello", " !echo", "!", "!!", "! "])("does not produce an executable command for %j", (input) => {
		expect(parseDirectBash(input)).toBeUndefined();
	});
});

describe("DirectBashController", () => {
	it("owns one bounded activity and correlates updates", () => {
		const changed = vi.fn();
		const controller = new DirectBashController({ maxOutputBytes: 12, maxOutputLines: 2, onChange: changed });
		const started = controller.start({ id: "one", command: "printf hi", excludeFromContext: false, ownerSessionId: "s1" });
		expect(started).toMatchObject({ id: "rpc-bash:one", kind: "terminal", status: "running", body: { command: "printf hi", text: "" } });
		expect(() => controller.start({ id: "two", command: "pwd", excludeFromContext: false })).toThrow("direct bash already running");
		expect(controller.handleEvent({ type: "bash_execution_update", id: "other", delta: "stale" })).toBe(false);
		expect(controller.handleEvent({ type: "bash_execution_update", id: "one", delta: "first\nsecond\nthird" })).toBe(true);
		expect(controller.getSnapshot()?.outputTail).toBe("second\nthird");
		expect(changed).toHaveBeenCalled();
	});

	it("accepts missing ids only for the sole active operation and joins split unicode", () => {
		const controller = new DirectBashController();
		controller.start({ id: "one", command: "printf emoji", excludeFromContext: false });
		controller.handleEvent({ type: "bash_execution_update", delta: "\ud83d" });
		controller.handleEvent({ type: "bash_execution_update", delta: "\ude80" });
		expect(controller.getSnapshot()?.outputTail).toBe("🚀");
	});

	it.each([
		[{ output: "ok", exitCode: 0, cancelled: false, truncated: false }, "succeeded", "exit 0"],
		[{ output: "bad", exitCode: 2, cancelled: false, truncated: false }, "failed", "exit 2"],
		[{ output: "stopped", exitCode: undefined, cancelled: true, truncated: false }, "cancelled", "cancelled"],
		[{ output: "tail", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/full.log" }, "succeeded", "exit 0 · truncated · /tmp/full.log"],
	] as const)("finalizes from Pi's authoritative result", (result, status, summary) => {
		const controller = new DirectBashController();
		controller.start({ id: "one", command: "cmd", excludeFromContext: false });
		controller.requestCancellation();
		const final = controller.complete("one", result);
		expect(final).toMatchObject({ status, outputTail: result.output, result: { summary } });
	});

	it("keeps late updates out after completion and reset", () => {
		const controller = new DirectBashController();
		controller.start({ id: "one", command: "cmd", excludeFromContext: true });
		controller.complete("one", { output: "final", exitCode: 0, cancelled: false, truncated: false });
		expect(controller.handleEvent({ type: "bash_execution_update", id: "one", delta: "late" })).toBe(false);
		controller.reset();
		expect(controller.getSnapshot()).toBeUndefined();
		expect(controller.handleEvent({ type: "bash_execution_update", id: "one", delta: "older" })).toBe(false);
	});

	it("preserves output that arrives before the final response but makes the result authoritative", () => {
		const controller = new DirectBashController();
		controller.start({ id: "one", command: "cmd", excludeFromContext: false });
		controller.handleEvent({ type: "bash_execution_update", id: "one", delta: "streamed" });
		controller.complete("one", { output: "authoritative", exitCode: 0, cancelled: false, truncated: false });
		expect(controller.getSnapshot()?.outputTail).toBe("authoritative");
	});
});
