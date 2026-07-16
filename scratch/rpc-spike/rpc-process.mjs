import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function toError(error) {
	return error instanceof Error ? error : new Error(String(error));
}

export function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== "object") return value;
	const sorted = {};
	for (const key of Object.keys(value).sort()) {
		const child = value[key];
		if (child !== undefined) sorted[key] = sortKeys(child);
	}
	return sorted;
}

export function canonicalJson(value) {
	return JSON.stringify(sortKeys(value), null, 2);
}

export class RpcProcess {
	#child;
	#nextRequestId = 0;
	#stdoutBuffer = "";
	#stderrBuffer = "";
	#pending = new Map();
	#events = new Set();
	#uiHandler;
	#exited = false;
	#bytes = 0;
	#parseNanos = 0n;

	constructor({ cwd = repoRoot, extensions = ["src/extension.ts"], env = {} } = {}) {
		const cli = resolve(cwd, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
		const args = [cli, "--mode", "rpc"];
		for (const extension of extensions) args.push("-e", extension);
		this.#child = spawn(process.execPath, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.#child.stdout.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk) => this.#handleStdout(chunk));
		this.#child.stderr.setEncoding("utf8");
		this.#child.stderr.on("data", (chunk) => {
			this.#stderrBuffer += chunk;
		});
		this.#child.once("error", (error) => this.#handleExit(toError(error)));
		this.#child.once("exit", (code, signal) => {
			this.#handleExit(new Error(`RPC process exited code=${code} signal=${signal}. stderr=${this.#stderrBuffer}`));
		});
	}

	get stderr() {
		return this.#stderrBuffer;
	}

	get metrics() {
		return {
			stdoutBytes: this.#bytes,
			parseMs: Number(this.#parseNanos) / 1_000_000,
		};
	}

	onEvent(listener) {
		this.#events.add(listener);
		return () => this.#events.delete(listener);
	}

	setUiRequestHandler(handler) {
		this.#uiHandler = handler;
	}

	async send(command, { timeoutMs = 30_000 } = {}) {
		if (this.#exited) throw new Error(`RPC process is not running. stderr=${this.#stderrBuffer}`);
		const id = command.id ?? `spike_${++this.#nextRequestId}_${randomUUID()}`;
		const request = { ...command, id };
		return await new Promise((resolvePromise, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Timed out waiting for ${command.type} response after ${timeoutMs}ms. stderr=${this.#stderrBuffer}`));
			}, timeoutMs);
			this.#pending.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolvePromise(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			this.#child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
				if (!error) return;
				this.#pending.delete(id);
				clearTimeout(timeout);
				reject(toError(error));
			});
		});
	}

	sendNoWait(command) {
		if (this.#exited) throw new Error(`RPC process is not running. stderr=${this.#stderrBuffer}`);
		const id = command.id ?? `spike_${++this.#nextRequestId}_${randomUUID()}`;
		this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return id;
	}

	sendUiResponse(response) {
		if (this.#exited) return;
		this.#child.stdin.write(`${JSON.stringify(response)}\n`);
	}

	async waitFor(predicate, { timeoutMs = 30_000, label = "event" } = {}) {
		const existing = [];
		return await new Promise((resolvePromise, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
			}, timeoutMs);
			const unsubscribe = this.onEvent((event) => {
				existing.push(event);
				if (!predicate(event, existing)) return;
				clearTimeout(timeout);
				unsubscribe();
				resolvePromise(event);
			});
		});
	}

	async dispose() {
		if (this.#exited) return;
		this.#child.kill("SIGTERM");
		await Promise.race([
			once(this.#child, "exit"),
			new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
		]);
		this.#exited = true;
	}

	#handleStdout(chunk) {
		this.#bytes += Buffer.byteLength(chunk);
		this.#stdoutBuffer += chunk;
		while (true) {
			const newlineIndex = this.#stdoutBuffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
			if (line.length === 0) continue;
			this.#handleLine(line);
		}
	}

	#handleLine(line) {
		let parsed;
		const started = process.hrtime.bigint();
		try {
			parsed = JSON.parse(line);
		} finally {
			this.#parseNanos += process.hrtime.bigint() - started;
		}

		if (parsed.type === "response") {
			const pending = parsed.id ? this.#pending.get(parsed.id) : undefined;
			if (!pending) return;
			this.#pending.delete(parsed.id);
			pending.resolve(parsed);
			return;
		}

		if (parsed.type === "extension_ui_request") {
			this.#uiHandler?.(parsed, this);
			return;
		}

		for (const listener of this.#events) listener(parsed);
	}

	#handleExit(error) {
		this.#exited = true;
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			pending.reject(error);
		}
	}
}

export async function writeJsonl(path, records) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}
