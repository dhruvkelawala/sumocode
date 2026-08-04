import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	decodeRpcTreeNavigationOutcome,
	decodeRpcTreeNavigationPayload,
	encodeRpcTreeNavigationOutcome,
	encodeRpcTreeNavigationPayload,
	executeRpcTreeNavigation,
	InMemoryRpcTreeNavigationOutcomeBroker,
	registerRpcTreeNavigationCommand,
	RPC_TREE_NAVIGATION_COMMAND,
	RPC_TREE_NAVIGATION_RESULT_STATUS_KEY,
	type RpcTreeNavigationRequest,
} from "./tree-navigation-command.js";

const requestId = "019f8a78-b4f5-7b7b-b774-2d2e4bce9001";

function request(overrides: Partial<RpcTreeNavigationRequest> = {}): RpcTreeNavigationRequest {
	return { requestId, targetId: "target", summarize: false, ...overrides };
}

function encoded(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function context(options: {
	mode?: "rpc" | "tui";
	hasUI?: boolean;
	target?: unknown;
	leafId?: string | null;
	cancelled?: boolean;
	navigate?: (targetId: string, options?: Record<string, unknown>) => Promise<{ cancelled: boolean }>;
} = {}): ExtensionCommandContext {
	let leafId = options.leafId ?? "target";
	return {
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		sessionManager: {
			getEntry: vi.fn(() => options.target),
			getLeafId: vi.fn(() => leafId),
		},
		navigateTree: vi.fn(async (targetId: string, navigateOptions?: Record<string, unknown>) => {
			if (options.navigate) return options.navigate(targetId, navigateOptions);
			leafId = targetId;
			return { cancelled: options.cancelled ?? false };
		}),
	} as unknown as ExtensionCommandContext;
}

function statusValue(ctx: ExtensionCommandContext): string {
	const calls = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls;
	const call = calls.find(([key]) => key === RPC_TREE_NAVIGATION_RESULT_STATUS_KEY);
	return call?.[1] as string;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("RPC tree navigation compatibility command", () => {
	it("registers only the hidden compatibility command", () => {
		const registerCommand = vi.fn();
		registerRpcTreeNavigationCommand({ registerCommand } as unknown as ExtensionAPI);
		expect(registerCommand).toHaveBeenCalledWith(RPC_TREE_NAVIGATION_COMMAND, expect.objectContaining({ description: expect.any(String) }));
	});

	it.each([
		["malformed base64", "not-base64="],
		["non-canonical base64", "YQ"],
		["malformed JSON", encoded("not json")],
		["unknown keys", encoded({ ...request(), extra: true })],
		["invalid UUID", encoded({ ...request(), requestId: "not-a-uuid" })],
		["empty target", encoded({ ...request(), targetId: "   " })],
		["target control", encoded({ ...request(), targetId: "ok\nno" })],
		["custom instructions with no summary", encoded({ ...request(), customInstructions: "not allowed" })],
	])("rejects %s", (_name, value) => {
		expect(() => decodeRpcTreeNavigationPayload(value)).toThrow();
	});

	it("enforces encoded, target, custom-instruction, and decoded JSON limits", () => {
		expect(() => decodeRpcTreeNavigationPayload("A".repeat(24_577))).toThrow(/too large/);
		expect(() => decodeRpcTreeNavigationPayload(encoded({ ...request(), targetId: "x".repeat(257) }))).toThrow();
		expect(() => decodeRpcTreeNavigationPayload(encoded({ ...request(), summarize: true, customInstructions: "x".repeat(16_385) }))).toThrow();
		const decodedLimit = Buffer.alloc(18_433, 0x20);
		expect(() => decodeRpcTreeNavigationPayload(Buffer.from(decodedLimit).toString("base64url"))).toThrow();
	});

	it("requires RPC mode and UI", async () => {
		const payload = encodeRpcTreeNavigationPayload(request());
		const nonRpc = context({ mode: "tui" });
		await executeRpcTreeNavigation(payload, nonRpc);
		expect((nonRpc.ui.notify as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("tree navigation requires SumoCode RPC mode", "warning");
		const noUi = context({ hasUI: false });
		await executeRpcTreeNavigation(payload, noUi);
		expect((noUi.ui.notify as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("tree navigation requires SumoCode RPC mode", "warning");
	});

	it.each([
		["no summary", request(), { summarize: false }],
		["default summary", request({ summarize: true }), { summarize: true }],
		["custom multiline summary", request({ summarize: true, customInstructions: "first line\nsecond line" }), { summarize: true, customInstructions: "first line\nsecond line" }],
	] as const)("forwards %s without replaceInstructions", async (_name, value, expectedOptions) => {
		const ctx = context({ target: { type: "message", message: { role: "assistant", content: "answer" } }, leafId: "new-leaf" });
		await executeRpcTreeNavigation(encodeRpcTreeNavigationPayload(value), ctx);
		expect(ctx.navigateTree).toHaveBeenCalledWith("target", expectedOptions);
		expect(ctx.navigateTree).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ replaceInstructions: expect.anything() }));
		const outcome = decodeRpcTreeNavigationOutcome(statusValue(ctx));
		expect(outcome).toMatchObject({ requestId, status: "committed", leafId: "target" });
	});

	it.each([
		["committed", { cancelled: false }, "committed"],
		["cancelled", { cancelled: true }, "cancelled"],
	] as const)("publishes exactly one %s outcome", async (_name, result, status) => {
		const ctx = context({ target: { type: "message", message: { role: "assistant", content: "answer" } }, cancelled: result.cancelled });
		await executeRpcTreeNavigation(encodeRpcTreeNavigationPayload(request()), ctx);
		const statuses = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.filter(([key]) => key === RPC_TREE_NAVIGATION_RESULT_STATUS_KEY);
		expect(statuses).toHaveLength(1);
		expect(decodeRpcTreeNavigationOutcome(statuses[0]?.[1] as string)).toMatchObject({ status, leafId: "target" });
	});

	it("turns navigation errors into one generic error outcome and no payload leak", async () => {
		const secret = "do not leak this custom instruction";
		const ctx = context({ target: { type: "message", message: { role: "assistant", content: "answer" } }, navigate: async () => { throw new Error(secret); } });
		await executeRpcTreeNavigation(encodeRpcTreeNavigationPayload(request({ summarize: true, customInstructions: secret })), ctx);
		const outcome = decodeRpcTreeNavigationOutcome(statusValue(ctx));
		expect(outcome).toEqual({ requestId, status: "error", leafId: "target" });
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("tree navigation failed", "error");
		expect(JSON.stringify((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(secret);
	});

	it.each([
		["user", { type: "message", message: { role: "user", content: "selected\ntext" } }, "selected\ntext"],
		["custom message", { type: "custom_message", content: "custom selected" }, "custom selected"],
	] as const)("returns selected text for a successful %s target", async (_name, target, text) => {
		const ctx = context({ target });
		await executeRpcTreeNavigation(encodeRpcTreeNavigationPayload(request()), ctx);
		expect(decodeRpcTreeNavigationOutcome(statusValue(ctx))).toMatchObject({ editorText: text });
	});

	it("does not return editor text for assistant or bookkeeping targets", async () => {
		for (const target of [{ type: "message", message: { role: "assistant", content: "answer" } }, { type: "branch_summary", summary: "summary" }]) {
			const ctx = context({ target });
			await executeRpcTreeNavigation(encodeRpcTreeNavigationPayload(request()), ctx);
			expect(decodeRpcTreeNavigationOutcome(statusValue(ctx))).not.toHaveProperty("editorText");
		}
	});

	it("does not resolve a waiter for a stale request id", async () => {
		vi.useFakeTimers();
		const broker = new InMemoryRpcTreeNavigationOutcomeBroker();
		const waiter = broker.register(requestId, 100);
		broker.publish({ requestId: "019f8a78-b4f5-7b7b-b774-2d2e4bce9002", status: "committed", leafId: "wrong" });
		vi.advanceTimersByTime(100);
		await expect(waiter).rejects.toThrow(/Timed out/);
	});

	it("round-trips an outcome with selected text", () => {
		const outcome = { requestId, status: "committed" as const, leafId: "leaf", editorText: "a\nb" };
		expect(decodeRpcTreeNavigationOutcome(encodeRpcTreeNavigationOutcome(outcome))).toEqual(outcome);
	});
});