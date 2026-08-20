import net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "herdr:pi";
const AGENT = "pi";

type AgentState = "working" | "blocked" | "idle";
type SendRequestAttempt = (request: unknown, timeoutMs: number) => Promise<boolean>;

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

function sendSocketRequestAttempt(path: string, request: unknown, timeoutMs: number): Promise<boolean> {
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

async function sendRequest(attempt: SendRequestAttempt, request: unknown): Promise<void> {
	if (await attempt(request, 500)) return;
	await attempt(request, 1500);
}

function sessionRef(ctx: SessionContext): { agent_session_path?: string; agent_session_id?: string } {
	try {
		const path = ctx.sessionManager?.getSessionFile?.();
		if (typeof path === "string" && path.startsWith("/")) return { agent_session_path: path };
	} catch {
		// Fall through to the session id when Pi cannot expose its file.
	}
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) return { agent_session_id: id };
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
	const send = (request: unknown) => sendRequest(attempt, request);
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

	const queuedStates: QueuedState[] = [];
	let sendInFlight = false;

	const sendState = (state: QueuedState) => send({
		id: requestId("state"),
		method: "pane.report_agent",
		params: {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			state: state.state,
			message: state.message,
			seq: state.seq,
			...(currentContext ? sessionRef(currentContext) : {}),
		},
	});

	const drainStateQueue = async (): Promise<void> => {
		if (sendInFlight) return;
		sendInFlight = true;
		try {
			while (true) {
				const state = queuedStates.shift();
				if (!state) break;
				await sendState(state);
			}
		} finally {
			sendInFlight = false;
			if (queuedStates.length > 0) void drainStateQueue();
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

	const eventBus = pi.events as { on?: (name: string, handler: (data: unknown) => void) => void } | undefined;
	eventBus?.on?.("herdr:blocked", (data: unknown) => {
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
		currentContext = ctx as SessionContext;
		active = ctx.isIdle?.() === false;
		await reportSession(currentContext, event.reason);
		publishState(true);
	});
	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx as SessionContext;
		active = true;
		void reportSession(currentContext);
		void publishState();
	});
	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx as SessionContext;
		if (ctx.isIdle?.() !== true) return;
		active = false;
		void publishState();
	});
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "quit") return;
		void send({
			id: requestId("release"),
			method: "pane.release_agent",
			params: { pane_id: paneId, source: SOURCE, agent: AGENT, seq: nextSeq() },
		});
	});
}
