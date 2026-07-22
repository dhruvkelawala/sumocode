import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeActivityText } from "../activity/domain.js";
import { TerminalTaskManager } from "./task-manager.js";
import {
	buildObservationResult,
	buildStartResult,
	buildStopResult,
	buildTerminalResultMessage,
	buildWaitResult,
	describeTerminal,
	TERMINAL_TOOL_DESCRIPTIONS,
	TERMINAL_TOOL_GUIDELINES,
} from "./terminal-prompt.js";
import { terminalActivitySnapshot, type TerminalDeliveryReceipt, type TerminalTaskSnapshot } from "./task-types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const MAX_TERMINAL_IDS = 64;
const COMPLETION_OUTPUT_BYTES = 8 * 1024;

const StringEnum = <T extends readonly string[]>(values: T, options?: { description?: string }) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(options?.description ? { description: options.description } : {}) });

function makeToolResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function sessionId(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	if (!id) throw new Error("Current Pi session has no stable session id");
	return id;
}

interface ObservableCompletions {
	readonly ids: ReadonlySet<string>;
	readonly receipts: readonly TerminalDeliveryReceipt[];
}

function completionsFromContext(ctx: ExtensionContext): ObservableCompletions {
	const ids = new Set<string>();
	const receipts: TerminalDeliveryReceipt[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as unknown as Record<string, unknown>;
		let details: unknown;
		if (record.type === "custom_message") details = record.details;
		else if (record.type === "message") {
			const message = record.message;
			if (message && typeof message === "object" && (message as { role?: unknown }).role === "custom") {
				details = (message as { details?: unknown }).details;
			}
		}
		if (!details || typeof details !== "object") continue;
		const completionId = (details as { completionId?: unknown }).completionId;
		const claimToken = (details as { deliveryClaimToken?: unknown }).deliveryClaimToken;
		if (typeof completionId !== "string") continue;
		ids.add(completionId);
		if (typeof claimToken === "string") receipts.push({ completionId, claimToken });
	}
	return { ids, receipts };
}

function completionDetails(manager: TerminalTaskManager, task: TerminalTaskSnapshot) {
	const output = sanitizeActivityText(manager.getOutput(task, COMPLETION_OUTPUT_BYTES)).slice(-COMPLETION_OUTPUT_BYTES);
	return {
		completionId: task.completionId,
		deliveryClaimToken: task.deliveryClaimToken,
		ownerSessionId: task.ownerSessionId,
		activity: terminalActivitySnapshot(task, output),
	};
}

export class TerminalDeliveryCoordinator {
	private active: { ownerSessionId: string; ctx: ExtensionContext } | undefined;
	private unsubscribe: (() => void) | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private flushQueued = false;
	private flushing = false;

	public constructor(
		private readonly pi: ExtensionAPI,
		private readonly manager: TerminalTaskManager,
	) {
		this.unsubscribe = manager.addChangeListener((task) => {
			if (task.ownerSessionId === this.active?.ownerSessionId) this.requestFlush();
		});
	}

	public bind(ctx: ExtensionContext): void {
		this.active = { ownerSessionId: sessionId(ctx), ctx };
		this.safeReconcile(ctx);
		this.requestFlush();
	}

	public touch(ctx: ExtensionContext): void {
		if (this.active?.ownerSessionId !== sessionId(ctx)) return;
		this.active = { ownerSessionId: this.active.ownerSessionId, ctx };
		this.safeReconcile(ctx);
	}

	public flushWhenIdle(ctx: ExtensionContext): void {
		this.touch(ctx);
		if (this.active?.ownerSessionId === sessionId(ctx) && ctx.isIdle()) this.requestFlush();
	}

	public unbind(): void {
		this.active = undefined;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	public dispose(): void {
		this.unbind();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	public reconcile(ctx: ExtensionContext): void {
		const ownerSessionId = sessionId(ctx);
		this.manager.acknowledge(ownerSessionId, completionsFromContext(ctx).receipts);
		const retryDelay = this.manager.getClaimRetryDelay(ownerSessionId);
		if (retryDelay === undefined && this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
	}

	private safeReconcile(ctx: ExtensionContext): void {
		try {
			this.reconcile(ctx);
		} catch {
			// Lock contention or a stale external writer must not escape a Pi event
			// handler. Claimed delivery remains durable and lease-retryable.
			this.scheduleLeaseRetry(50);
		}
	}

	private requestFlush(): void {
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			try {
				this.flush();
			} catch {
				// A failed send/claim stays claimed or pending in durable state. Retry
				// after a bounded delay instead of creating an unhandled rejection.
				this.scheduleLeaseRetry(50);
			}
		});
	}

	private flush(): void {
		const active = this.active;
		if (!active || this.flushing || !active.ctx.isIdle()) return;
		this.flushing = true;
		try {
			this.reconcile(active.ctx);
			const claimed = this.manager.claimPending(active.ownerSessionId, true, 1)
				.sort((left, right) => Number(left.completionPolicy === "wake") - Number(right.completionPolicy === "wake"));
			for (const task of claimed) {
				// An explicit observer or an expired concurrent claimant can take
				// ownership before this stack reaches send. The unique claim token,
				// not completionId alone, decides which coordinator may publish.
				const current = this.manager.get(task.id, active.ownerSessionId);
				if (
					current?.deliveryState !== "claimed" || !current.deliveryClaimToken ||
					current.completionId !== task.completionId || current.deliveryClaimToken !== task.deliveryClaimToken
				) continue;
				const observable = completionsFromContext(active.ctx);
				if (current.completionId && observable.ids.has(current.completionId)) {
					// Pi has no insertion idempotency key, but an already-observable stable
					// completion ID proves insertion happened before a crash. Acknowledge
					// under this exact reclaim token instead of appending a duplicate.
					this.manager.acknowledge(active.ownerSessionId, [{
						completionId: current.completionId,
						claimToken: current.deliveryClaimToken,
					}]);
					continue;
				}
				const details = completionDetails(this.manager, current);
				this.pi.sendMessage(
					{
						customType: "terminal-result",
						content: buildTerminalResultMessage(current, this.manager.getOutput(current, COMPLETION_OUTPUT_BYTES)),
						display: true,
						details,
					},
					{ deliverAs: "followUp", triggerTurn: current.completionPolicy === "wake" },
				);
				if (current.completionPolicy === "wake") break;
			}
			queueMicrotask(() => {
				if (this.active?.ownerSessionId !== active.ownerSessionId) return;
				this.safeReconcile(this.active.ctx);
			});
			const retryDelay = this.manager.getClaimRetryDelay(active.ownerSessionId);
			if (retryDelay !== undefined) this.scheduleLeaseRetry(retryDelay);
		} finally {
			this.flushing = false;
		}
	}

	private scheduleLeaseRetry(delayMs: number): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.requestFlush();
		}, Math.max(0, delayMs) + 10);
		this.retryTimer.unref?.();
	}
}

export function installTerminalTools(
	pi: ExtensionAPI,
	manager: TerminalTaskManager,
): TerminalDeliveryCoordinator {
	const coordinator = new TerminalDeliveryCoordinator(pi, manager);

	pi.registerTool({
		name: "terminal_start",
		label: "Terminal Start",
		description: TERMINAL_TOOL_DESCRIPTIONS.start,
		promptSnippet: "Start a durable non-interactive shell terminal that runs independently.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run without stdin." }),
			title: Type.String({ description: "Short human-readable terminal title." }),
			working_dir: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project directory." })),
			completion: Type.Optional(StringEnum(["passive", "wake"] as const, { description: "Completion disposition. Defaults to passive." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			coordinator.touch(ctx);
			const task = await manager.start({
				ownerSessionId: sessionId(ctx),
				command: params.command,
				cwd: params.working_dir ?? ctx.cwd,
				title: params.title,
				completionPolicy: params.completion ?? "passive",
			});
			return makeToolResult(buildStartResult(task), { task, activity: terminalActivitySnapshot(task, "") });
		},
	});

	pi.registerTool({
		name: "terminal_check",
		label: "Terminal Check",
		description: TERMINAL_TOOL_DESCRIPTIONS.check,
		promptSnippet: "Inspect one managed terminal without blocking.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({ id: Type.String({ description: "Terminal id returned by terminal_start." }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			coordinator.touch(ctx);
			const observation = manager.check(params.id, sessionId(ctx));
			if (!observation) return makeToolResult(`Unknown terminal ${params.id}.`, { id: params.id, status: "unknown" });
			return makeToolResult(buildObservationResult(observation), {
				task: observation.task,
				activity: terminalActivitySnapshot(observation.task, observation.output),
			});
		},
	});

	pi.registerTool({
		name: "terminal_wait",
		label: "Terminal Wait",
		description: TERMINAL_TOOL_DESCRIPTIONS.wait,
		promptSnippet: "Wait for managed terminals with a bounded normal timeout result.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_TERMINAL_IDS, description: "Terminal ids to wait for." }),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_TIMEOUT_MS, description: "Wait timeout in milliseconds. Defaults to 30000." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			coordinator.touch(ctx);
			const result = await manager.wait(params.ids, sessionId(ctx), params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS, signal);
			return makeToolResult(buildWaitResult(result), {
				...result,
				activities: result.settled.map(({ task, output }) => terminalActivitySnapshot(task, output)),
			});
		},
	});

	pi.registerTool({
		name: "terminal_stop",
		label: "Terminal Stop",
		description: TERMINAL_TOOL_DESCRIPTIONS.stop,
		promptSnippet: "Stop one or more complete managed terminal process trees.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_TERMINAL_IDS, description: "Terminal ids to stop." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			coordinator.touch(ctx);
			const results = await manager.stop(params.ids, sessionId(ctx));
			return makeToolResult(buildStopResult(results), { results });
		},
	});

	pi.registerTool({
		name: "terminal_list",
		label: "Terminal List",
		description: TERMINAL_TOOL_DESCRIPTIONS.list,
		promptSnippet: "List current-session durable managed terminals and completion disposition.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			// Inventory is deliberately detached from delivery reconciliation: no
			// acknowledge, observation, suppression, lease, or context touch.
			const tasks = manager.list(sessionId(ctx));
			return makeToolResult(
				tasks.length > 0 ? tasks.map(describeTerminal).join("\n") : "No terminals tracked for this session.",
				{ tasks },
			);
		},
	});

	pi.on("session_start", (_event, ctx) => coordinator.bind(ctx));
	pi.on("agent_start", (_event, ctx) => coordinator.touch(ctx));
	pi.on("agent_end", (_event, ctx) => coordinator.flushWhenIdle(ctx));
	pi.on("agent_settled", (_event, ctx) => coordinator.flushWhenIdle(ctx));
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "custom") return;
		try {
			coordinator.reconcile(ctx);
		} catch {
			// The durable claim remains retryable; never reject Pi's event dispatch.
		}
	});
	pi.on("session_shutdown", (event) => {
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason === "quit") coordinator.dispose();
		else coordinator.unbind();
	});
	return coordinator;
}
