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

export interface SumoRpcClientOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly requestTimeoutMs?: number;
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
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

function defaultUiResponse(request: RpcExtensionUIRequest): RpcExtensionUIResponse | undefined {
	if (request.method === "select" || request.method === "input" || request.method === "editor" || request.method === "confirm") {
		return { type: "extension_ui_response", id: request.id, cancelled: true };
	}
	return undefined;
}

export class SumoRpcClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private nextRequestId = 0;
	private exited = false;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<RpcEventListener>();
	private uiRequestHandler: RpcUiRequestHandler | undefined;

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

	public setUiRequestHandler(handler: RpcUiRequestHandler | undefined): void {
		this.uiRequestHandler = handler;
	}

	public async start(): Promise<void> {
		if (this.child) throw new Error("RPC child already started");
		this.exited = false;
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
			this.handleExit(new Error(`Failed to parse RPC line: ${toError(error).message}. line=${line}`));
			return;
		}

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
			const response = await (this.uiRequestHandler?.(request, this) ?? defaultUiResponse(request));
			if (response) this.sendUiResponse(response);
		} catch {
			const response = defaultUiResponse(request);
			if (response) this.sendUiResponse(response);
		}
	}

	private handleExit(error: Error): void {
		this.exited = true;
		this.child = undefined;
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}
}
