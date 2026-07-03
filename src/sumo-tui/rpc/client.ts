import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";

type PendingRequest = {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
	timeout: NodeJS.Timeout;
};

export type RpcEventListener = (event: AgentSessionEvent) => void;
export type RpcUiRequestHandler = (request: RpcExtensionUIRequest, client: SumoRpcClient) => RpcExtensionUIResponse | void | Promise<RpcExtensionUIResponse | void>;
export type RpcProtocolErrorHandler = (line: string, error: Error) => void;
export type RpcExitListener = (error: Error) => void;

export interface SumoRpcClientOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly requestTimeoutMs?: number;
	readonly onProtocolError?: RpcProtocolErrorHandler;
}

const MAX_CONSECUTIVE_PROTOCOL_ERRORS = 3;
const MAX_STDERR_BUFFER_LENGTH = 64 * 1024;
const CHILD_STOP_GRACE_MS = 2_000;
/**
 * Notification-facing messages (toasts, modal text) must stay terse -- the
 * full stderr buffer (up to MAX_STDERR_BUFFER_LENGTH = 64 KiB) is fine for the
 * process-exit stderr dump written straight to the real stderr stream, but
 * embedding that much text in a rendered notification would blow out the UI.
 */
export const NOTIFICATION_STDERR_LIMIT = 500;

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** Truncates a message's tail to a bounded length for user-facing surfaces (notifications, toasts). */
export function truncateForNotification(message: string, limit = NOTIFICATION_STDERR_LIMIT): string {
	if (message.length <= limit) return message;
	return `${message.slice(0, limit)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isResponse(value: unknown): value is RpcResponse {
	return isRecord(value) && value.type === "response";
}

function isExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	return isRecord(value) && value.type === "extension_ui_request" && typeof value.id === "string";
}

export class SumoRpcClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private nextRequestId = 0;
	private consecutiveProtocolErrors = 0;
	private exited = false;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<RpcEventListener>();
	private readonly exitListeners = new Set<RpcExitListener>();
	private uiRequestHandler: RpcUiRequestHandler | undefined;
	private exitNotified = false;

	public constructor(private readonly options: SumoRpcClientOptions) {}

	public get pid(): number | undefined {
		return this.child?.pid;
	}

	public get stderr(): string {
		return this.stderrBuffer;
	}

	public onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	/**
	 * Fires exactly once when the child exits or errors outside of a deliberate
	 * `stop()` call (i.e. the same path `handleExit` already uses to reject
	 * in-flight requests). Without this, a child that dies while idle -- no
	 * pending request to reject -- leaves the host with no signal at all: it
	 * keeps rendering against a corpse, modals/overlays dangle forever, and
	 * `refreshStats` silently swallows the resulting "not running" error on
	 * every poll. `stop()` (deliberate host-initiated shutdown) does not fire
	 * this listener.
	 */
	public onExit(listener: RpcExitListener): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	public setUiRequestHandler(handler: RpcUiRequestHandler | undefined): void {
		this.uiRequestHandler = handler;
	}

	public async start(): Promise<void> {
		if (this.child) throw new Error("RPC child already started");
		this.exited = false;
		this.exitNotified = false;
		const child = spawn(this.options.command, [...this.options.args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrBuffer += chunk;
			if (this.stderrBuffer.length > MAX_STDERR_BUFFER_LENGTH) {
				this.stderrBuffer = this.stderrBuffer.slice(-MAX_STDERR_BUFFER_LENGTH);
			}
		});
		child.once("error", (error) => this.handleExit(toError(error)));
		child.once("exit", (code, signal) => {
			this.handleExit(new Error(`RPC child exited code=${code ?? "null"} signal=${signal ?? "null"}. stderr=${this.stderrBuffer}`));
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		if (this.exited) throw new Error(`RPC child exited during startup. stderr=${this.stderrBuffer}`);
	}

	public async stop(): Promise<void> {
		const child = this.child;
		if (!child || this.exited) return;
		// A deliberate stop() must not also fire onExit: the child's own
		// once("exit", ...) listener registered in start() still runs and calls
		// handleExit for this same exit, and without this guard that would fire
		// a spurious "child crashed" notification (and duplicate teardown) for
		// what is actually an intentional shutdown (SIGINT/SIGTERM/normal quit).
		this.exitNotified = true;
		child.stdin.end();
		child.kill("SIGTERM");
		await Promise.race([
			once(child, "exit"),
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
		if (!this.exited) child.kill("SIGKILL");
		this.exited = true;
		this.child = undefined;
		this.rejectPending(new Error("RPC child stopped"));
	}

	public async send(command: RpcCommand, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<RpcResponse> {
		if (!this.child || this.exited) throw new Error(`RPC child is not running. stderr=${this.stderrBuffer}`);
		const id = command.id ?? `sumocode_rpc_${++this.nextRequestId}_${randomUUID()}`;
		const request = { ...command, id } satisfies RpcCommand;
		return await new Promise<RpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${command.type} response after ${timeoutMs}ms. stderr=${this.stderrBuffer}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.child!.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (pending) {
					this.pending.delete(id);
					clearTimeout(pending.timeout);
				}
				reject(toError(error));
			});
		});
	}

	public sendUiResponse(response: RpcExtensionUIResponse): void {
		if (!this.child || this.exited) return;
		this.child.stdin.write(`${JSON.stringify(response)}\n`);
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		while (true) {
			const newlineIndex = this.stdoutBuffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line.length > 0) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			const parseError = toError(error);
			this.consecutiveProtocolErrors += 1;
			this.options.onProtocolError?.(line, parseError);
			if (this.consecutiveProtocolErrors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
				this.handleExit(new Error(`Failed to parse ${MAX_CONSECUTIVE_PROTOCOL_ERRORS} consecutive RPC lines: ${parseError.message}. line=${line}`));
			}
			return;
		}
		this.consecutiveProtocolErrors = 0;

		if (isResponse(parsed)) {
			const pending = parsed.id ? this.pending.get(parsed.id) : undefined;
			if (!pending) return;
			this.pending.delete(parsed.id!);
			clearTimeout(pending.timeout);
			pending.resolve(parsed);
			return;
		}

		if (isExtensionUiRequest(parsed)) {
			void this.handleUiRequest(parsed);
			return;
		}

		for (const listener of this.eventListeners) listener(parsed as AgentSessionEvent);
	}

	private async handleUiRequest(request: RpcExtensionUIRequest): Promise<void> {
		try {
			const response = await this.uiRequestHandler?.(request, this);
			// No handler installed, or the handler produced no response object: this covers
			// unknown/future Pi extension_ui methods falling through an exhaustive switch, as well
			// as deliberate fire-and-forget methods (notify/setStatus/setWidget/setTitle/
			// set_editor_text) whose handlers resolve void by design. Sending an unconditional
			// cancelled response is safe for both: Pi's rpc-mode.js drops extension_ui_response for
			// ids it has no pending request for (pendingExtensionRequests.get(...) returns
			// undefined -> early return, no error), and it unwedges any dialog-style request that
			// would otherwise block the child forever.
			this.sendUiResponse(response ?? { type: "extension_ui_response", id: request.id, cancelled: true });
		} catch {
			this.sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
		}
	}

	private handleExit(error: Error): void {
		this.exited = true;
		const child = this.child;
		if (child) this.terminateChild(child);
		this.child = undefined;
		this.rejectPending(error);
		if (this.exitNotified) return;
		this.exitNotified = true;
		for (const listener of this.exitListeners) listener(error);
	}

	private terminateChild(child: ChildProcessWithoutNullStreams): void {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		const forceKill = setTimeout(() => child.kill("SIGKILL"), CHILD_STOP_GRACE_MS);
		forceKill.unref?.();
		child.once("exit", () => clearTimeout(forceKill));
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}
}
