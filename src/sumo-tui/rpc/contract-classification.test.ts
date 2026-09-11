import { expect, expectTypeOf, it } from "vitest";
import type { AgentSessionEvent, RpcCommand, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
	AGENT_EVENT_DISPOSITIONS,
	EXTENSION_UI_METHOD_DISPOSITIONS,
	RPC_COMMAND_DISPOSITIONS,
} from "./contract-classification.js";

/**
 * The disposition matrix is declarative source, so the map keys themselves are
 * the seam under test: `toEqualTypeOf` against each shipped union fails to
 * compile when Pi adds a member until it is classified in the map.
 */
it("classifies every shipped RPC command, including the 0.85.1 queue and retry verbs", () => {
	expect(RPC_COMMAND_DISPOSITIONS.prompt.kind).toBe("implemented");
	expect(RPC_COMMAND_DISPOSITIONS.get_state.kind).toBe("implemented");
	expect(RPC_COMMAND_DISPOSITIONS.get_available_thinking_levels.kind).toBe("implemented");
	expect(RPC_COMMAND_DISPOSITIONS.set_thinking_level.kind).toBe("implemented");
	expect(RPC_COMMAND_DISPOSITIONS.get_tree.kind).toBe("intentionally-bypassed");
	expect(RPC_COMMAND_DISPOSITIONS.clear_queue).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 090 (#377)" });
	expect(RPC_COMMAND_DISPOSITIONS.steer).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 090 (#377)" });
	expect(RPC_COMMAND_DISPOSITIONS.follow_up).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 090 (#377)" });
	expect(RPC_COMMAND_DISPOSITIONS.set_steering_mode).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 090 (#377)" });
	expect(RPC_COMMAND_DISPOSITIONS.set_follow_up_mode).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 090 (#377)" });
	expect(RPC_COMMAND_DISPOSITIONS.abort_retry).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 089 (#376)" });
	expect(RPC_COMMAND_DISPOSITIONS.bash).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 091 (#378)" });
	expect(RPC_COMMAND_DISPOSITIONS.abort_bash).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 091 (#378)" });
	expectTypeOf<keyof typeof RPC_COMMAND_DISPOSITIONS>().toEqualTypeOf<RpcCommand["type"]>();
});

it("classifies every shipped agent-session event under one primary consumer", () => {
	expect(AGENT_EVENT_DISPOSITIONS.agent_end.kind).toBe("projected");
	expect(AGENT_EVENT_DISPOSITIONS.thinking_level_changed).toMatchObject({ kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent" });
	expect(AGENT_EVENT_DISPOSITIONS.queue_update.kind).toBe("projected");
	expect(AGENT_EVENT_DISPOSITIONS.agent_settled.kind).toBe("scheduler-only");
	expect(AGENT_EVENT_DISPOSITIONS.turn_end.kind).toBe("scheduler-only");
	expect(AGENT_EVENT_DISPOSITIONS.message_update.kind).toBe("transcript-only");
	expect(AGENT_EVENT_DISPOSITIONS.message_end.kind).toBe("transcript-only");
	expect(AGENT_EVENT_DISPOSITIONS.tool_execution_end.kind).toBe("transcript-only");
	expect(AGENT_EVENT_DISPOSITIONS.entry_appended.kind).toBe("intentionally-ignored");
	expect(AGENT_EVENT_DISPOSITIONS.turn_start.kind).toBe("intentionally-ignored");
	expect(AGENT_EVENT_DISPOSITIONS.auto_retry_start).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 089 (#376)" });
	expect(AGENT_EVENT_DISPOSITIONS.summarization_retry_finished).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 089 (#376)" });
	expect(AGENT_EVENT_DISPOSITIONS.bash_execution_update).toMatchObject({ kind: "downstream-plan-owned", owner: "Plan 091 (#378)" });
	expectTypeOf<keyof typeof AGENT_EVENT_DISPOSITIONS>().toEqualTypeOf<AgentSessionEvent["type"]>();
});

it("maps every extension-UI method to a retained-host handler and response behavior", () => {
	expect(EXTENSION_UI_METHOD_DISPOSITIONS.select.owner).toContain("modals.select");
	expect(EXTENSION_UI_METHOD_DISPOSITIONS.notify.owner).toContain("notifications.notify");
	expect(EXTENSION_UI_METHOD_DISPOSITIONS.setWidget.owner).toContain("regionRegistry.mountWidget");
	for (const disposition of Object.values(EXTENSION_UI_METHOD_DISPOSITIONS)) {
		expect(disposition.owner.length).toBeGreaterThan(0);
		expect(disposition.response.length).toBeGreaterThan(0);
	}
	expectTypeOf<keyof typeof EXTENSION_UI_METHOD_DISPOSITIONS>().toEqualTypeOf<RpcExtensionUIRequest["method"]>();
});
