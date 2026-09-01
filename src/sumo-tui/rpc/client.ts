import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { BoundedUtf8Tail, JsonLineDecoder, boundRetainedResult } from "../../child-protocol.js";
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
/** Receives a size-only frame summary and a bounded, payload-safe parse error. */
export type RpcProtocolErrorHandler = (frameSummary: string, error: Error) => void;

/**
 * The RPC child's process exit code/signal, structurally exposed alongside
 * the formatted `onExit` error instead of requiring callers to regex-parse
 * `error.message` (previously the only way to tell "child exited 100 for a
 * deliberate `/reload`" apart from "child crashed" -- see
 * RpcChildExitError and createRpcExitHandler in host.ts).
 */
export interface RpcChildExitInfo {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/**
 * `onExit`'s error for a normal child-process "exit" event carries the
 * process's exit code/signal as typed fields (`undefined` for the "error"
 * event case, e.g. spawn failure, which has no process exit code). Consumers
 * that only care about the message keep working unchanged since this is
 * still a plain `Error`.
 */
export class RpcChildExitError extends Error {
	public readonly code: number | null | undefined;
	public readonly signal: NodeJS.Signals | null | undefined;

	public constructor(message: string, info?: RpcChildExitInfo) {
		super(message);
		this.name = "RpcChildExitError";
		this.code = info?.code;
		this.signal = info?.signal;
	}
}

export type RpcExitListener = (error: Error) => void;

export interface SumoRpcClientOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly preSpawnedChild?: ChildProcessWithoutNullStreams;
	/** Injection seam for tests; production always uses the real node spawn. */
	readonly spawnFn?: typeof spawn;
	readonly env?: NodeJS.ProcessEnv;
	readonly requestTimeoutMs?: number;
	readonly onProtocolError?: RpcProtocolErrorHandler;
}

const MAX_CONSECUTIVE_PROTOCOL_ERRORS = 3;
const JSON_PARSE_REASON_MAX_BYTES = 500;
const CHILD_STOP_GRACE_MS = 2_000;
const CHILD_CLOSE_GRACE_MS = 1_000;
const PRESPAWN_ERROR = Symbol.for("sumocode.rpc.preSpawnError");
/**
 * Notification-facing messages (toasts, modal text) must stay terse -- the
 * bounded stderr tail is fine for the process-exit dump written straight to
 * the real stderr stream, but
 * embedding that much text in a rendered notification would blow out the UI.
 */
export const NOTIFICATION_STDERR_LIMIT = 500;

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function safeJsonParseReason(cause: unknown): string {
	const message = toError(cause).message;
	if (message.startsWith("Unexpected token")) {
		const location = message.match(/ at position \d+(?: \(line \d+ column \d+\))?$/)?.[0] ?? "";
		return `Unexpected token in JSON${location}`;
	}
	if (message.includes(" is not valid JSON")) return "Invalid JSON syntax";
	return boundRetainedResult(message, JSON_PARSE_REASON_MAX_BYTES);
}

function waitForChildClose(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("close", finish);
			resolve();
		};
		const timer = setTimeout(finish, CHILD_STOP_GRACE_MS + CHILD_CLOSE_GRACE_MS);
		child.once("close", finish);
	});
}

/** Truncates a message for user-facing surfaces (notifications, toasts). */
export function truncateForNotification(message: string, limit = NOTIFICATION_STDERR_LIMIT): string {
	return boundRetainedResult(message, limit);
}

type RpcMessageLike = { type?: string | undefined; id?: string | undefined };

function isString(value: string | undefined): value is string {
	return typeof value === "string";
}

/** JSON.parse succeeds on `null` and other primitives; only objects carry protocol fields. */
function isMessageRecord(value: RpcMessageLike | null): value is RpcMessageLike {
	return typeof value === "object" && value !== null;
}

function isResponse(value: RpcMessageLike): value is RpcResponse {
	return value.type === "response";
}

function isExtensionUiRequest(value: RpcMessageLike): value is RpcExtensionUIRequest {
	return value.type === "extension_ui_request" && isString(value.id);
}

export class SumoRpcClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private stdoutFrames: JsonLineDecoder | undefined;
	private stderrTail = new BoundedUtf8Tail();
	private stdoutDataListener: ((chunk: string | Uint8Array) => void) | undefined;
	private stderrDataListener: ((chunk: string | Uint8Array) => void) | undefined;
	private nextRequestId = 0;
	private consecutiveProtocolErrors = 0;
	private exited = false;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<RpcEventListener>();
	private readonly exitListeners = new Set<RpcExitListener>();
	private uiRequestHandler: RpcUiRequestHandler | undefined;
	private exitNotified = false;

	public constructor(private readonly options: SumoRpcClientOptions) {}

	/** Observability/test seam: the adopted child process, when present. */
	public get adoptedChild(): ChildProcessWithoutNullStreams | undefined {
		return this.child;
	}

	public get pid(): number | undefined {
		return this.child?.pid;
	}

	public get stderr(): string {
		return this.stderrTail.toString();
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

	public async start(onAdopted?: () => void): Promise<void> {
		if (this.child) throw new Error("RPC child already started");
		this.exited = false;
		this.exitNotified = false;
		const spawnChild = this.options.spawnFn ?? spawn;
		const child = this.options.preSpawnedChild ?? spawnChild(this.options.command, [...this.options.args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.stderrTail = new BoundedUtf8Tail();
		this.stdoutFrames = new JsonLineDecoder({
			onLine: (line) => {
				const trimmed = line.trim();
				if (trimmed) this.handleLine(trimmed);
			},
			onError: (error) => this.handleExit(error),
		});
		this.stdoutDataListener = (chunk) => this.stdoutFrames?.write(chunk);
		this.stderrDataListener = (chunk) => this.stderrTail.append(chunk);
		child.stdout.on("data", this.stdoutDataListener);
		child.stderr.on("data", this.stderrDataListener);
		// Without this listener, an EPIPE on the kernel pipe (child closed stdin,
		// or died in the window before Node's 'exit' event lands) is an unhandled
		// 'error' event on the stdin stream, which Node treats as fatal and
		// crashes the host process. A logging no-op is enough: send() and
		// sendUiResponse() already guard on child/exited state and have their own
		// write-callback error handling, so this listener only needs to swallow
		// the stream-level error so it never throws, not react to it further --
		// the child's 'exit'/'error' event (handleExit) is what actually notifies
		// the rest of the host.
		child.stdin.on("error", (error) => {
			console.error(`[sumocode-rpc] child stdin error: ${toError(error).message}`);
		});
		child.once("error", (error) => this.handleExit(toError(error)));
		child.once("exit", (code, signal) => {
			if (!this.exitNotified) this.stdoutFrames?.end();
			this.handleExit(new RpcChildExitError(`RPC child exited code=${code ?? "null"} signal=${signal ?? "null"}. stderr=${this.stderr}`, { code, signal }));
		});

		// A pre-spawned child can fail or exit while the host module is still
		// importing, before the lifecycle listeners above exist. The entry file
		// saves asynchronous spawn errors on the child; Node retains completed
		// exitCode/signalCode. Adopt either state instead of treating dead stdin
		// as a live RPC transport and losing the original failure.
		// SAFETY: the entry file stamps PRESPAWN_ERROR onto the child before
		// handoff; reading it through the symbol keeps that channel private.
		const preSpawnError = (child as { [PRESPAWN_ERROR]?: unknown })[PRESPAWN_ERROR];
		let adoptionError: Error | undefined;
		if (preSpawnError !== undefined) {
			adoptionError = toError(preSpawnError);
		} else if (child.exitCode !== null || child.signalCode !== null) {
			adoptionError = new RpcChildExitError(
				`RPC child exited before host adoption code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}. stderr=${this.stderr}`,
				{ code: child.exitCode, signal: child.signalCode },
			);
		}
		if (adoptionError) {
			this.handleExit(adoptionError);
			throw adoptionError;
		}

		// Transfer signal ownership only after this client owns child lifecycle.
		// The callback runs synchronously so entry and host handlers never overlap.
		onAdopted?.();

		// Spawn-establishment gate. `pid` is populated synchronously whenever the
		// OS created the process, so the common path must not reinstate the old
		// fixed 50ms first-frame delay. A spawn failure leaves `pid` undefined and
		// settles through error/exit below. Every listener is already attached:
		// failures after successful spawn are delivered immediately through
		// onExit (the host subscribes before start()), rather than hidden behind a
		// speculative grace sleep.
		await new Promise<void>((resolve) => {
			if (child.pid !== undefined || this.exited) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, 50);
			const settle = () => {
				clearTimeout(timer);
				resolve();
			};
			child.once("spawn", settle);
			child.once("error", settle);
			child.once("exit", settle);
		});
		if (this.exited) throw new Error(`RPC child exited during startup. stderr=${this.stderr}`);
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
		const childClosed = waitForChildClose(child);
		const childExited = once(child, "exit");
		child.stdin.end();
		child.kill("SIGTERM");
		await Promise.race([
			childExited,
			new Promise((resolve) => setTimeout(resolve, CHILD_STOP_GRACE_MS)),
		]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await childClosed;
		// `close` follows all stdio closure. Removing listeners after the bounded
		// fallback also prevents any pipe-holding descendant from dispatching a
		// late RPC response after stop() resolves.
		this.detachChildStreams(child);
		this.exited = true;
		this.child = undefined;
		this.rejectPending(new Error("RPC child stopped"));
	}

	public async send(command: RpcCommand, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<RpcResponse> {
		if (!this.child || this.exited) throw new Error(`RPC child is not running. stderr=${this.stderr}`);
		const id = command.id ?? `sumocode_rpc_${++this.nextRequestId}_${randomUUID()}`;
		const request = { ...command, id } satisfies RpcCommand;
		return await new Promise<RpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${command.type} response after ${timeoutMs}ms. stderr=${this.stderr}`));
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
		// Same guard style as send(): the post-'exit' state is covered by the
		// `this.exited` check above, but the kernel pipe can already be closed
		// (child.stdin.writable === false) in the window before Node delivers
		// the 'exit' event. Without the writable check and an error callback,
		// this write can throw/EPIPE synchronously or emit an unhandled 'error'
		// on the stream and crash the host for what is, from the UI's
		// perspective, a fire-and-forget response.
		if (!this.child.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify(response)}\n`, (error) => {
			if (error) console.error(`[sumocode-rpc] sendUiResponse write failed: ${toError(error).message}`);
		});
	}

	private handleLine(line: string): void {
		let parsed: RpcMessageLike;
		try {
			// SAFETY: stdout lines are untyped JSON by definition; every consumer
			// below validates shape via isResponse/isExtensionUiRequest first.
			parsed = JSON.parse(line) as RpcMessageLike;
		} catch (cause) {
			const parseError = new Error(`Invalid JSON protocol frame: ${safeJsonParseReason(cause)}`);
			this.consecutiveProtocolErrors += 1;
			const frameSummary = `[invalid protocol frame: ${Buffer.byteLength(line, "utf8")} bytes]`;
			this.options.onProtocolError?.(frameSummary, parseError);
			if (this.consecutiveProtocolErrors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
				this.handleExit(new Error(`Failed to parse ${MAX_CONSECUTIVE_PROTOCOL_ERRORS} consecutive RPC lines. ${frameSummary}. ${parseError.message}`));
			}
			return;
		}
		this.consecutiveProtocolErrors = 0;

		// Stray child output can decode to a JSON primitive (e.g. console.log(null));
		// only object-shaped lines are protocol candidates.
		if (!isMessageRecord(parsed)) return;

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

		// SAFETY: parsed lines come from Pi's own RPC writer; event payloads are
		// consumed defensively downstream.
		this.dispatchEvent(parsed as AgentSessionEvent);
	}

	/**
	 * Runs each event listener in its own try/catch: this is a synchronous
	 * dispatch loop invoked straight from the child's decoded stdout frame, and
	 * the host's own client.onEvent
	 * listener synchronously runs transcript ingestion + a full render. A
	 * throw partway through the loop -- from a bad event shape, a rendering
	 * bug, whatever -- would otherwise propagate out of the 'data' event
	 * emission and, with no listener further up, crash the whole host
	 * (there was previously only an `unhandledRejection` handler, which does
	 * not catch synchronous throws). Catching per-listener also means one
	 * poisoned event can't stop the remaining listeners in the same dispatch
	 * from running, and never prevents the *next* event from being handled.
	 */
	private dispatchEvent(event: AgentSessionEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch (error) {
				console.error(`[sumocode-rpc] event listener threw for event type "${String(event.type)}": ${toError(error).message}`);
			}
		}
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
		} catch (error) {
			console.error(`[sumocode-rpc] extension_ui handler failed for method "${request.method}": ${truncateForNotification(toError(error).message)}`);
			this.sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
		}
	}

	private handleExit(error: Error): void {
		this.exited = true;
		if (this.exitNotified) {
			// Deliberate stop owns teardown. Keep the child reference and pending
			// callbacks alive until its stdio `close` boundary so buffered success
			// responses can still resolve before stop() rejects true leftovers.
			return;
		}
		const child = this.child;
		if (child) {
			this.detachChildStreams(child);
			this.terminateChild(child);
		}
		this.child = undefined;
		this.rejectPending(error);
		this.exitNotified = true;
		for (const listener of this.exitListeners) listener(error);
	}

	private detachChildStreams(child: ChildProcessWithoutNullStreams): void {
		if (this.stdoutDataListener) child.stdout.removeListener("data", this.stdoutDataListener);
		if (this.stderrDataListener) child.stderr.removeListener("data", this.stderrDataListener);
		this.stdoutDataListener = undefined;
		this.stderrDataListener = undefined;
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
