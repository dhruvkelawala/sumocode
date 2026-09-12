import type { AgentSessionEvent, RpcResponse } from "@earendil-works/pi-coding-agent";

export type DirectBashResult = Extract<RpcResponse, { command: "bash"; success: true }>["data"];
import type { ActivitySnapshot, ActivityStatus } from "../../activity/domain.js";
import { ACTIVITY_OUTPUT_MAX_BYTES, ACTIVITY_OUTPUT_MAX_LINES, boundedOutputTail } from "../../activity/output-tail.js";

export interface ParsedDirectBash {
	readonly command: string;
	readonly excludeFromContext: boolean;
}

/** Parse only the editor's leading !/!! syntax, preserving the shell body byte-for-byte. */
export function parseDirectBash(text: string): ParsedDirectBash | undefined {
	if (!text.startsWith("!")) return undefined;
	const excludeFromContext = text.startsWith("!!");
	const markerLength = excludeFromContext ? 2 : 1;
	const command = text.slice(markerLength + (text[markerLength] === " " ? 1 : 0));
	return command.trim().length === 0 ? undefined : { command, excludeFromContext };
}

export interface DirectBashStart {
	readonly id: string;
	readonly command: string;
	readonly excludeFromContext: boolean;
	readonly ownerSessionId?: string;
}

export interface DirectBashControllerOptions {
	readonly maxOutputBytes?: number;
	readonly maxOutputLines?: number;
	readonly now?: () => number;
	readonly onChange?: (activity?: ActivitySnapshot) => void;
}

interface ActiveDirectBash extends DirectBashStart {
	readonly createdAt: number;
	output: string;
	pendingHighSurrogate: string;
	settled: boolean;
	activity: ActivitySnapshot;
}

function isHighSurrogate(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= 0xd800 && code <= 0xdbff;
}

function resultStatus(result: DirectBashResult): ActivityStatus {
	if (result.cancelled) return "cancelled";
	return result.exitCode === 0 || result.exitCode === undefined ? "succeeded" : "failed";
}

function resultSummary(result: DirectBashResult): string {
	const parts = [result.cancelled ? "cancelled" : `exit ${result.exitCode ?? 0}`];
	if (result.truncated) parts.push("truncated");
	if (result.fullOutputPath) parts.push(result.fullOutputPath);
	return parts.join(" · ");
}

/** Owns the single Pi-native direct-bash operation and its bounded live projection. */
export class DirectBashController {
	private active: ActiveDirectBash | undefined;
	private readonly maxOutputBytes: number;
	private readonly maxOutputLines: number;
	private readonly now: () => number;
	private readonly onChange: (activity?: ActivitySnapshot) => void;

	public constructor(options: DirectBashControllerOptions = {}) {
		this.maxOutputBytes = options.maxOutputBytes ?? ACTIVITY_OUTPUT_MAX_BYTES;
		this.maxOutputLines = options.maxOutputLines ?? ACTIVITY_OUTPUT_MAX_LINES;
		this.now = options.now ?? Date.now;
		this.onChange = options.onChange ?? (() => undefined);
	}

	public get isRunning(): boolean {
		return this.active?.settled === false;
	}

	public getSnapshot(): ActivitySnapshot | undefined {
		return this.active?.activity;
	}

	public start(start: DirectBashStart): ActivitySnapshot {
		if (this.isRunning) throw new Error("direct bash already running");
		const createdAt = this.now();
		const activity: ActivitySnapshot = {
			id: `rpc-bash:${start.id}`,
			kind: "terminal",
			title: "bash",
			status: "running",
			subject: start.command,
			invocation: { command: start.command, excludeFromContext: start.excludeFromContext },
			outputTail: "",
			body: { kind: "terminal", command: start.command, text: "" },
			...(start.ownerSessionId !== undefined && { ownerSessionId: start.ownerSessionId }),
			createdAt,
			updatedAt: createdAt,
		};
		this.active = { ...start, createdAt, output: "", pendingHighSurrogate: "", settled: false, activity };
		this.onChange(activity);
		return activity;
	}

	public handleEvent(event: AgentSessionEvent | unknown): boolean {
		const active = this.active;
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- parse the RPC event boundary before entering controller state.
		if (!active || active.settled || typeof event !== "object" || event === null) return false;
		// SAFETY: RPC events are untrusted; these field checks establish the only
		// bash-update representation consumed below.
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion
		const update = event as { readonly type?: unknown; readonly id?: unknown; readonly delta?: unknown };
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- parse the RPC event boundary before entering controller state.
		if (update.type !== "bash_execution_update" || typeof update.delta !== "string") return false;
		if (update.id !== undefined && update.id !== active.id) return false;
		let delta = active.pendingHighSurrogate + update.delta;
		active.pendingHighSurrogate = "";
		const last = delta.at(-1);
		if (last && isHighSurrogate(last)) {
			active.pendingHighSurrogate = last;
			delta = delta.slice(0, -1);
		}
		active.output = boundedOutputTail(`${active.output}${delta}`, { maxBytes: this.maxOutputBytes, maxLines: this.maxOutputLines });
		active.activity = this.withOutput(active, active.output);
		this.onChange(active.activity);
		return true;
	}

	public requestCancellation(): boolean {
		return this.active?.settled === false;
	}

	public complete(id: string, result: DirectBashResult): ActivitySnapshot {
		const active = this.active;
		if (!active || active.id !== id || active.settled) throw new Error("direct bash response does not match the active operation");
		active.settled = true;
		active.pendingHighSurrogate = "";
		active.output = boundedOutputTail(result.output, { maxBytes: this.maxOutputBytes, maxLines: this.maxOutputLines });
		const settledAt = this.now();
		active.activity = {
			...this.withOutput(active, active.output),
			status: resultStatus(result),
			result: { summary: resultSummary(result) },
			updatedAt: settledAt,
			settledAt,
		};
		this.onChange(active.activity);
		return active.activity;
	}

	public fail(message: string): ActivitySnapshot | undefined {
		const active = this.active;
		if (!active || active.settled) return active?.activity;
		active.settled = true;
		const settledAt = this.now();
		active.activity = { ...active.activity, status: "lost", result: { error: message }, updatedAt: settledAt, settledAt };
		this.onChange(active.activity);
		return active.activity;
	}

	public reset(): void {
		this.active = undefined;
		this.onChange(undefined);
	}

	private withOutput(active: ActiveDirectBash, output: string): ActivitySnapshot {
		return {
			...active.activity,
			outputTail: output,
			body: { kind: "terminal", command: active.command, text: output },
			updatedAt: this.now(),
		};
	}
}
