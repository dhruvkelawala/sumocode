import { describe, expect, it, vi } from "vitest";
import { installHerdrRpcBridge } from "./herdr-rpc-bridge.js";

function createHarness(
	env: NodeJS.ProcessEnv = {},
	sendRequestAttempt: (request: any, timeoutMs: number) => Promise<boolean> = async () => true,
) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const eventHandlers = new Map<string, (data: any) => unknown>();
	const attempts: Array<{ request: any; timeoutMs: number }> = [];
	const pi = {
		on: vi.fn((name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler)),
		events: { on: vi.fn((name: string, handler: (data: any) => unknown) => eventHandlers.set(name, handler)) },
	};
	installHerdrRpcBridge(pi as never, {
		env,
		sendRequestAttempt: async (request, timeoutMs) => {
			attempts.push({ request, timeoutMs });
			return sendRequestAttempt(request, timeoutMs);
		},
	});
	return {
		handlers,
		eventHandlers,
		attempts,
		get requests() { return attempts.map(({ request }) => request); },
		pi,
	};
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

const contextWithoutSession = {
	isIdle: () => true,
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

	it("reports the session path, display name, and initial idle state", async () => {
		const harness = createHarness(enabledEnv);
		await harness.handlers.get("session_start")?.({ reason: "startup" }, context);

		expect(harness.requests.map((request) => request.method)).toEqual([
			"pane.report_agent_session",
			"pane.report_metadata",
			"pane.report_agent",
		]);
		expect(harness.requests[0].params).toMatchObject({
			pane_id: "w1:p2",
			source: "herdr:pi",
			agent: "pi",
			agent_session_path: "/tmp/session.jsonl",
			session_start_source: "startup",
		});
		expect(harness.requests[1].params).toMatchObject({
			pane_id: "w1:p2",
			source: "sumocode:display",
			agent: "pi",
			display_agent: "sumocode",
		});
		expect(harness.requests[2].params).toMatchObject({ state: "idle", agent_session_path: "/tmp/session.jsonl" });
	});

	it("renames the displayed agent without changing Pi authority", async () => {
		const harness = createHarness(enabledEnv);
		await harness.handlers.get("session_start")?.({ reason: "startup" }, contextWithoutSession);
		await flush();

		const metadata = harness.requests.find((request) => request.method === "pane.report_metadata");
		expect(metadata).toBeDefined();
		expect(metadata.params).toMatchObject({
			pane_id: "w1:p2",
			source: "sumocode:display",
			agent: "pi",
			display_agent: "sumocode",
		});
		const state = harness.requests.find((request) => request.method === "pane.report_agent");
		expect(state.params).toMatchObject({ source: "herdr:pi", agent: "pi" });
	});

	it("publishes working, blocked, and settled lifecycle states", async () => {
		const harness = createHarness(enabledEnv);
		await harness.handlers.get("session_start")?.({ reason: "startup" }, context);
		await flush();
		harness.attempts.length = 0;

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

	it("retries a dropped report with a longer timeout", async () => {
		let callCount = 0;
		const harness = createHarness(enabledEnv, async () => {
			callCount += 1;
			return callCount > 1;
		});

		await harness.handlers.get("session_start")?.({ reason: "startup" }, contextWithoutSession);
		await flush();

		// The display metadata report is the first send: its 500ms attempt
		// fails, and the same request is retried at 1500ms. The following
		// state report then succeeds on its first attempt.
		expect(harness.attempts.map(({ timeoutMs }) => timeoutMs)).toEqual([500, 1500, 500]);
		expect(harness.requests[0]).toBe(harness.requests[1]);
		expect(harness.requests[1]).toMatchObject({ method: "pane.report_metadata", params: { display_agent: "sumocode" } });
		expect(harness.requests[2]).toMatchObject({ method: "pane.report_agent", params: { state: "idle" } });
	});

	it("keeps retrying display metadata until Herdr receives it", async () => {
		vi.useFakeTimers();
		try {
			let metadataAttempts = 0;
			const harness = createHarness(enabledEnv, async (request) => {
				if (request.method === "pane.report_metadata") {
					metadataAttempts += 1;
					return metadataAttempts >= 3;
				}
				return true;
			});

			await harness.handlers.get("session_start")?.({ reason: "startup" }, contextWithoutSession);
			await vi.advanceTimersByTimeAsync(0);

			expect(metadataAttempts).toBe(2);
			expect(harness.requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state)).toEqual(["idle"]);

			await vi.advanceTimersByTimeAsync(2_000);

			const metadataRequests = harness.requests.filter((request) => request.method === "pane.report_metadata");
			expect(metadataAttempts).toBe(3);
			expect(metadataRequests).toHaveLength(3);
			expect(metadataRequests[0]).toBe(metadataRequests[1]);
			expect(metadataRequests[1]).toBe(metadataRequests[2]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps retrying a settled state until Herdr receives it", async () => {
		vi.useFakeTimers();
		try {
			let failSettledIdle = false;
			let idleAttempts = 0;
			const harness = createHarness(enabledEnv, async (request) => {
				if (failSettledIdle && request.method === "pane.report_agent" && request.params.state === "idle") {
					idleAttempts += 1;
					return idleAttempts >= 3;
				}
				return true;
			});
			await harness.handlers.get("session_start")?.({ reason: "startup" }, contextWithoutSession);
			await vi.runAllTimersAsync();

			harness.handlers.get("agent_start")?.({}, { ...contextWithoutSession, isIdle: () => false });
			await vi.runAllTimersAsync();
			failSettledIdle = true;
			harness.handlers.get("agent_settled")?.({}, contextWithoutSession);
			await vi.runAllTimersAsync();

			expect(idleAttempts).toBe(3);
			expect(harness.requests.filter(
				(request) => request.method === "pane.report_agent" && request.params.state === "idle",
			)).toHaveLength(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops retrying queued states when the session shuts down", async () => {
		vi.useFakeTimers();
		try {
			let failSettledIdle = false;
			let idleAttempts = 0;
			const harness = createHarness(enabledEnv, async (request) => {
				if (failSettledIdle && request.method === "pane.report_agent" && request.params.state === "idle") {
					idleAttempts += 1;
					return false;
				}
				return true;
			});
			await harness.handlers.get("session_start")?.({ reason: "startup" }, contextWithoutSession);
			await vi.runAllTimersAsync();
			harness.handlers.get("agent_start")?.({}, { ...contextWithoutSession, isIdle: () => false });
			await vi.runAllTimersAsync();

			failSettledIdle = true;
			harness.handlers.get("agent_settled")?.({}, contextWithoutSession);
			await vi.advanceTimersByTimeAsync(0);
			expect(idleAttempts).toBe(2);

			harness.handlers.get("session_shutdown")?.({ reason: "reload" }, contextWithoutSession);
			await vi.runAllTimersAsync();
			expect(idleAttempts).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends every state transition in order while a report is in flight", async () => {
		let releaseFirstReport: ((delivered: boolean) => void) | undefined;
		let holdReports = false;
		const harness = createHarness(enabledEnv, async () => {
			if (!holdReports) return true;
			holdReports = false;
			return new Promise<boolean>((resolve) => {
				releaseFirstReport = resolve;
			});
		});
		await harness.handlers.get("session_start")?.({ reason: "startup" }, contextWithoutSession);
		await flush();
		harness.attempts.length = 0;
		holdReports = true;

		harness.handlers.get("agent_start")?.({}, { ...contextWithoutSession, isIdle: () => false });
		harness.eventHandlers.get("herdr:blocked")?.({ active: true, label: "approval" });
		harness.eventHandlers.get("herdr:blocked")?.({ active: false });
		await flush();

		expect(harness.requests.map((request) => request.params.state)).toEqual(["working"]);
		releaseFirstReport?.(true);
		await flush();
		await flush();
		expect(harness.requests.map((request) => request.params.state)).toEqual(["working", "blocked", "working"]);
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
