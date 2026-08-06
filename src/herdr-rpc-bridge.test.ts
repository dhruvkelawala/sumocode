import { describe, expect, it, vi } from "vitest";
import { installHerdrRpcBridge } from "./herdr-rpc-bridge.js";

function createHarness(env: NodeJS.ProcessEnv = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const eventHandlers = new Map<string, (data: any) => unknown>();
	const requests: any[] = [];
	const pi = {
		on: vi.fn((name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler)),
		events: { on: vi.fn((name: string, handler: (data: any) => unknown) => eventHandlers.set(name, handler)) },
	};
	installHerdrRpcBridge(pi as never, {
		env,
		sendRequest: async (request) => {
			requests.push(request);
		},
	});
	return { handlers, eventHandlers, requests, pi };
}

const enabledEnv = {
	SUMOCODE_RPC_CHILD: "1",
	HERDR_ENV: "1",
	HERDR_PANE_ID: "w1:p2",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
};

const context = {
	isIdle: () => true,
	sessionManager: {
		getSessionFile: () => "/tmp/session.jsonl",
		getSessionId: () => "session-id",
	},
};

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installHerdrRpcBridge", () => {
	it("does not install outside SumoCode's visible RPC child", () => {
		const harness = createHarness({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/tmp/herdr.sock" });
		expect(harness.pi.on).not.toHaveBeenCalled();
		expect(harness.pi.events.on).not.toHaveBeenCalled();
	});

	it("reports the session path and initial idle state", async () => {
		const harness = createHarness(enabledEnv);
		await harness.handlers.get("session_start")?.({ reason: "startup" }, context);

		expect(harness.requests.map((request) => request.method)).toEqual([
			"pane.report_agent_session",
			"pane.report_agent",
		]);
		expect(harness.requests[0].params).toMatchObject({
			pane_id: "w1:p2",
			source: "herdr:pi",
			agent: "pi",
			agent_session_path: "/tmp/session.jsonl",
			session_start_source: "startup",
		});
		expect(harness.requests[1].params).toMatchObject({ state: "idle", agent_session_path: "/tmp/session.jsonl" });
	});

	it("publishes working, blocked, and settled lifecycle states", async () => {
		const harness = createHarness(enabledEnv);
		await harness.handlers.get("session_start")?.({ reason: "startup" }, context);
		harness.requests.length = 0;

		harness.handlers.get("agent_start")?.({}, { ...context, isIdle: () => false });
		await flush();
		harness.eventHandlers.get("herdr:blocked")?.({ active: true, label: "approval" });
		await flush();
		harness.eventHandlers.get("herdr:blocked")?.({ active: false });
		await flush();
		harness.handlers.get("agent_settled")?.({}, context);
		await flush();

		expect(harness.requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state)).toEqual([
			"working",
			"blocked",
			"working",
			"idle",
		]);
	});

	it("releases authority only when the Pi process quits", async () => {
		const harness = createHarness(enabledEnv);
		harness.handlers.get("session_shutdown")?.({ reason: "resume" }, context);
		await flush();
		expect(harness.requests).toEqual([]);

		harness.handlers.get("session_shutdown")?.({ reason: "quit" }, context);
		await flush();
		expect(harness.requests).toHaveLength(1);
		expect(harness.requests[0]).toMatchObject({ method: "pane.release_agent" });
	});
});
