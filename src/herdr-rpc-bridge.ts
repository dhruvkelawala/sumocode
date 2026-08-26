import net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "herdr:pi";
const AGENT = "pi";
const DISPLAY_SOURCE = "sumocode:display";
const DISPLAY_AGENT = "sumocode";
const STATE_RETRY_DELAY_MS = 2_000;

type AgentState = "working" | "blocked" | "idle";
/** Wire request for Herdr's `pane.report_*` socket methods. */
interface HerdrSocketRequest {
	readonly id: string;
	readonly method: string;
	readonly params: HerdrRequestParams;
}

/** Params shared by the `pane.*` methods this bridge sends. */
interface HerdrRequestParams {
	readonly pane_id: string;
	readonly source: string;
	readonly agent: string;
	readonly seq?: number;
	readonly state?: AgentState;
	readonly message?: string | undefined;
	readonly session_start_source?: string | undefined;
	readonly agent_session_path?: string;
	readonly agent_session_id?: string;
	readonly display_agent?: string;
}

type SendRequestAttempt = (request: HerdrSocketRequest, timeoutMs: number) => Promise<boolean>;

interface QueuedState {
	readonly state: AgentState;
	readonly message?: string;
	readonly seq: number;
}

interface HerdrRpcBridgeOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly sendRequestAttempt?: SendRequestAttempt;
}

interface SessionContext {
	readonly isIdle?: () => boolean;
	readonly sessionManager?: {
		readonly getSessionFile?: () => string | undefined;
		readonly getSessionId?: () => string | undefined;
	};
}

function socketEndpoint(path: string): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path;
}

function sendSocketRequestAttempt(path: string, request: HerdrSocketRequest, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const socket = net.createConnection(socketEndpoint(path));
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			socket.destroy();
			resolve(delivered);
		};
		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
	});
}

async function sendRequest(attempt: SendRequestAttempt, request: HerdrSocketRequest): Promise<boolean> {
	if (await attempt(request, 500)) return true;
	return attempt(request, 1500);
}

interface SessionRef {
	agent_session_path?: string;
	agent_session_id?: string;
}

const isAbsolutePath = (value: string | undefined): value is string =>
	typeof value === "string" && value.startsWith("/");
const isNonEmptyString = (value: string | undefined): value is string =>
	typeof value === "string" && value.length > 0;

function sessionRef(ctx: SessionContext): SessionRef {
	try {
		const path = ctx.sessionManager?.getSessionFile?.();
		if (isAbsolutePath(path)) return { agent_session_path: path };
	} catch {
		// Fall through to the session id when Pi cannot expose its file.
	}
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (isNonEmptyString(id)) return { agent_session_id: id };
	} catch {
		// A lifecycle update without a session ref can still publish state.
	}
	return {};
}

/**
 * Publishes SumoCode's visible RPC-child lifecycle through Herdr's Pi authority.
 * Herdr's managed Pi integration intentionally ignores generic RPC sessions;
 * SumoCode is different because its retained host provides the visible PTY UI.
 */
export function installHerdrRpcBridge(pi: ExtensionAPI, options: HerdrRpcBridgeOptions = {}): void {
	const env = options.env ?? process.env;
	const paneId = env.HERDR_PANE_ID;
	const path = env.HERDR_SOCKET_PATH;
	if (env.SUMOCODE_RPC_CHILD !== "1" || env.HERDR_ENV !== "1" || !paneId || !path) return;

	const attempt = options.sendRequestAttempt ?? ((request, timeoutMs) => sendSocketRequestAttempt(path, request, timeoutMs));
	const send = (request: HerdrSocketRequest) => sendRequest(attempt, request);
	let seq = Date.now() * 1000;
	let active = false;
	let blockedCount = 0;
	let blockedMessage: string | undefined;
	let currentContext: SessionContext | undefined;
	let lastState: AgentState | undefined;
	let lastMessage: string | undefined;
	const nextSeq = () => ++seq;
	const requestId = (kind: string) => `${SOURCE}:${kind}:${Date.now()}:${nextSeq()}`;

	const reportSession = async (ctx: SessionContext, reason?: string) => {
		const ref = sessionRef(ctx);
		if (!ref.agent_session_path && !ref.agent_session_id) return;
		await send({
			id: requestId("session"),
			method: "pane.report_agent_session",
			params: {
				pane_id: paneId,
				source: SOURCE,
				agent: AGENT,
				seq: nextSeq(),
				session_start_source: reason,
				...ref,
			},
		});
	};

	let stopped = false;

	// Herdr grants full lifecycle authority only to the hardcoded
	// ("herdr:pi", "pi") pair, so the semantic agent must stay "pi". The
	// display name is presentation-only and can be renamed without touching
	// that authority.
	const buildDisplayNameRequest = () => ({
		id: requestId("display"),
		method: "pane.report_metadata",
		params: {
			pane_id: paneId,
			source: DISPLAY_SOURCE,
			agent: AGENT,
			display_agent: DISPLAY_AGENT,
			seq: nextSeq(),
		},
	});

	let displayRequest: HerdrSocketRequest | undefined;
	let displaySendInFlight = false;
	let displayRetryTimer: ReturnType<typeof setTimeout> | undefined;

	const scheduleDisplayRetry = (): void => {
		if (stopped || displayRetryTimer !== undefined || displayRequest === undefined) return;
		displayRetryTimer = setTimeout(() => {
			displayRetryTimer = undefined;
			void drainDisplayReport();
		}, STATE_RETRY_DELAY_MS);
		displayRetryTimer.unref?.();
	};

	const drainDisplayReport = async (): Promise<void> => {
		if (stopped || displaySendInFlight || displayRetryTimer !== undefined || displayRequest === undefined) return;
		displaySendInFlight = true;
		try {
			let delivered = false;
			try {
				delivered = await send(displayRequest);
			} catch {
				// Treat transport errors like dropped reports.
			}
			if (delivered) displayRequest = undefined;
		} finally {
			displaySendInFlight = false;
			if (!stopped && displayRequest !== undefined) scheduleDisplayRetry();
		}
	};

	const reportDisplayName = async () => {
		displayRequest ??= buildDisplayNameRequest();
		await drainDisplayReport();
	};

	// Keep the head until delivery. Dropping a settled report leaves Herdr
	// stuck on working because Pi will not emit the same transition again.
	const queuedStates: QueuedState[] = [];
	let sendInFlight = false;
	let stateRetryTimer: ReturnType<typeof setTimeout> | undefined;

	const sendState = (state: QueuedState) => {
		const params: HerdrRequestParams = {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			state: state.state,
			message: state.message,
			seq: state.seq,
		};
		if (currentContext) Object.assign(params, sessionRef(currentContext));
		return send({ id: requestId("state"), method: "pane.report_agent", params });
	};

	const scheduleStateRetry = (): void => {
		if (stopped || stateRetryTimer !== undefined || queuedStates.length === 0) return;
		stateRetryTimer = setTimeout(() => {
			stateRetryTimer = undefined;
			void drainStateQueue();
		}, STATE_RETRY_DELAY_MS);
		stateRetryTimer.unref?.();
	};

	const drainStateQueue = async (): Promise<void> => {
		if (stopped || sendInFlight || stateRetryTimer !== undefined) return;
		sendInFlight = true;
		try {
			while (!stopped) {
				const state = queuedStates[0];
				if (!state) return;
				let delivered = false;
				try {
					delivered = await sendState(state);
				} catch {
					// Treat transport errors like dropped reports.
				}
				if (!delivered) return;
				queuedStates.shift();
			}
		} finally {
			sendInFlight = false;
			if (!stopped && queuedStates.length > 0) scheduleStateRetry();
		}
	};

	const publishState = (force = false) => {
		const state: AgentState = blockedCount > 0 ? "blocked" : active ? "working" : "idle";
		const message = blockedCount > 0 ? blockedMessage : undefined;
		if (!force && state === lastState && message === lastMessage) return;
		lastState = state;
		lastMessage = message;
		queuedStates.push({ state, message, seq: nextSeq() });
		void drainStateQueue();
	};

	// SAFETY: the Pi runtime exposes an events bus with an optional on() registrar.
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- untyped Pi events surface; the payload is decoded defensively in the handler
	const eventBus = pi.events as { on?: (name: string, handler: (data: unknown) => void) => void } | undefined;
	eventBus?.on?.("herdr:blocked", (data) => {
		// SAFETY: decode of a cross-process payload; non-object payloads are ignored.
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary decode of an untyped IPC payload
		const report = typeof data === "object" && data !== null ? data as { active?: boolean; label?: string } : undefined;
		if (report?.active) {
			blockedCount += 1;
			blockedMessage = report.label;
		} else {
			blockedCount = Math.max(0, blockedCount - 1);
			if (blockedCount === 0) blockedMessage = undefined;
		}
		void publishState();
	});

	pi.on("session_start", async (event, ctx) => {
		// SAFETY: Pi's session context is the same shape the bridge reads; only
		// isIdle/reason members are accessed below.
		currentContext = ctx as SessionContext;
		active = ctx.isIdle?.() === false;
		await reportSession(currentContext, event.reason);
		await reportDisplayName();
		publishState(true);
	});
	pi.on("agent_start", (_event, ctx) => {
		// SAFETY: Pi's agent context is the same shape the bridge reads; only
		// isIdle members are accessed below.
		currentContext = ctx as SessionContext;
		active = true;
		void reportSession(currentContext);
		void publishState();
	});
	pi.on("agent_settled", (_event, ctx) => {
		// SAFETY: Pi's agent context is the same shape the bridge reads; only
		// isIdle members are accessed below.
		currentContext = ctx as SessionContext;
		if (ctx.isIdle?.() !== true) return;
		active = false;
		void publishState();
	});
	pi.on("session_shutdown", (event) => {
		// Pi replaces the extension runtime after every shutdown. Stop this
		// instance's retry loop; the next session owns a fresh bridge.
		stopped = true;
		if (stateRetryTimer !== undefined) {
			clearTimeout(stateRetryTimer);
			stateRetryTimer = undefined;
		}
		if (displayRetryTimer !== undefined) {
			clearTimeout(displayRetryTimer);
			displayRetryTimer = undefined;
		}
		displayRequest = undefined;
		queuedStates.length = 0;
		if (event.reason !== "quit") return;
		void send({
			id: requestId("release"),
			method: "pane.release_agent",
			params: { pane_id: paneId, source: SOURCE, agent: AGENT, seq: nextSeq() },
		});
	});
}
