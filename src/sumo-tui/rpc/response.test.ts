import { expect, expectTypeOf, it } from "vitest";
import type { AgentSessionEvent, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { responseData, type RpcResponseData } from "./response.js";

/**
 * Decode a wire frame the way the client's stdout reader does: untrusted JSON
 * typed as a protocol frame, so every guard below runs against real shape.
 */
function decodeFrame(json: string): RpcResponse {
	// SAFETY: the client casts decoded stdout lines to RpcResponse before any
	// validation; these fixtures reproduce frames the transport can deliver.
	return JSON.parse(json) as RpcResponse;
}

/**
 * Compile-time anchors for the pinned Pi 0.85.1 wire contract. `src/**` is the
 * only tree `pnpm exec tsc --noEmit` checks, so the type-level half of the
 * contract lives here; each anchor fails typecheck if a Pi bump changes a
 * payload SumoCode consumes. The installed worker's runtime shapes are proven
 * in `test/integration/rpc-contract.test.ts`.
 */
it("pins the 0.85.1 queue and thinking wire shapes", () => {
	expectTypeOf<RpcResponseData<"clear_queue">>().toEqualTypeOf<{ steering: string[]; followUp: string[] }>();
	expectTypeOf<RpcResponseData<"bash">>().toMatchTypeOf<{ output: string; cancelled: boolean; truncated: boolean }>();
	expectTypeOf<RpcResponseData<"get_available_thinking_levels">>().toEqualTypeOf<{ levels: RpcSessionState["thinkingLevel"][] }>();
	expectTypeOf<RpcResponseData<"set_thinking_level">>().toEqualTypeOf<undefined>();
	expectTypeOf<Extract<AgentSessionEvent, { type: "thinking_level_changed" }>["level"]>().toEqualTypeOf<RpcSessionState["thinkingLevel"]>();
});

it("requires a real boolean success and a matching command discriminator", () => {
	expect(() => responseData(decodeFrame('{"id":"1","type":"response","command":"get_state","success":"yes","data":{}}'), "get_state"))
		.toThrow("get_state failed: response did not report boolean success");
	expect(() => responseData(decodeFrame('{"id":"2","type":"response","command":"get_state","data":{}}'), "get_state"))
		.toThrow("get_state failed: response did not report boolean success");
	expect(() => responseData(decodeFrame('{"id":"3","type":"response","command":"get_state","success":false,"error":"boom"}'), "get_state"))
		.toThrow("get_state failed: boom");
	expect(() => responseData(decodeFrame('{"id":"4","type":"response","command":"get_state","success":true,"data":{}}'), "clear_queue"))
		.toThrow("clear_queue failed: unexpected response command get_state");
});

it("returns the typed payload for a well-formed success", () => {
	const cleared = responseData(decodeFrame('{"id":"5","type":"response","command":"clear_queue","success":true,"data":{"steering":["a"],"followUp":[]}}'), "clear_queue");
	expect(cleared).toEqual({ steering: ["a"], followUp: [] });
	expect(responseData(decodeFrame('{"id":"6","type":"response","command":"set_thinking_level","success":true}'), "set_thinking_level")).toBeUndefined();
});
