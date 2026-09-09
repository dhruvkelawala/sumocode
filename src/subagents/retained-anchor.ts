import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ProcessTreeMemberAnchor } from "../background-tasks/process-tree.js";
import { isRecord } from "../native-task-params.js";

// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- IPC boundary parser: anchor messages are untrusted process payloads validated before callbacks.
/** The original handle owns a stable group leader, never Pi's mutable title.
 * The anchor inherits the three pipes into Pi without copying/reopening them.
 * It ignores TERM and stays alive after Pi exits; only fenced KILL ends it.
 */
export class RetainedAnchor {
	public readonly proc: ChildProcessWithoutNullStreams;
	private exited = false;
	private killing = false;
	private started = false;
	private child?: ProcessTreeMemberAnchor;
	private childExited = false;

	public constructor(
		spawnImpl: typeof spawn,
		private readonly binary: string,
		private readonly args: string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; nonce?: string },
		private readonly callbacks: {
			started: (child: ProcessTreeMemberAnchor) => void;
			exited: (code: number | null, signal: string | null) => void;
			refused: (error: Error) => void;
		},
	) {
		const node = realpathSync(process.execPath);
		const stat = lstatSync(node);
		if (process.versions.bun || !isAbsolute(node) || basename(node) !== "node" || !stat.isFile()
			|| (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0 || options.env.NODE_OPTIONS || options.env.NODE_PATH) {
			throw new Error("retained anchor requires trusted Node without preload overrides");
		}
		// The census parses physical ps output lines. Keep the trusted anchor program on one argv line so a live anchor cannot blind census.
		// Newlines become statement separators; never add // line comments to ANCHOR_PROGRAM.
		const program = ANCHOR_PROGRAM.replace(/\r?\n/g, ";");
		if (program.includes("\n") || program.includes("\r")) throw new Error("retained anchor program must remain argv-safe");
		// SAFETY: the three inherited Pi streams are pipes; fd 3 is anchor-only IPC.
		this.proc = spawnImpl(node, ["-e", program, `sumocode-retained-anchor:${options.nonce ?? randomUUID()}`], {
			cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		this.proc.on("message", (message: unknown) => {
			try {
				this.assertLive();
				if (!this.started || !isRecord(message)) throw new Error();
				if (message.kind === "started" && !this.child && isRecord(message.child)) {
					const { pid, processStartTime } = message.child;
					if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid === this.proc.pid
						|| typeof processStartTime !== "string" || !processStartTime.trim() || processStartTime.length > 256) throw new Error();
					this.child = { pid, processStartTime };
					callbacks.started(this.child);
				} else if (message.kind === "exited" && this.child && !this.childExited
					&& (message.code === null || (typeof message.code === "number" && Number.isSafeInteger(message.code)))
					&& (message.signal === null || (typeof message.signal === "string" && /^SIG[A-Z0-9]+$/u.test(message.signal)))) {
					this.childExited = true;
					callbacks.exited(message.code, message.signal);
				} else throw new Error();
			} catch { callbacks.refused(new Error("retained anchor protocol refused")); }
		});
		this.proc.once("exit", () => {
			this.exited = true;
			if (!this.killing) callbacks.refused(new Error("retained anchor exited unexpectedly"));
		});
		this.proc.once("disconnect", () => {
			if (!this.killing) callbacks.refused(new Error("retained anchor channel lost"));
		});
	}

	public start(): void {
		this.assertLive();
		if (this.started) throw new Error("retained anchor already released");
		this.started = true;
		this.proc.send({ binary: this.binary, args: this.args }, (error) => {
			if (error) this.callbacks.refused(new Error("retained anchor release failed"));
		});
	}

	public assertLive(): void {
		if (this.exited || this.proc.exitCode != null || this.proc.signalCode != null) throw new Error("retained anchor handle lost");
	}

	public beforeSignal(signal: "SIGTERM" | "SIGKILL"): void {
		this.assertLive();
		if (signal === "SIGKILL") this.killing = true;
	}
}
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof

// This fixed stdlib program is embedded in source/bundles, not loaded from task
// paths. The launch travels over IPC; only a random nonce enters process argv.
// Keep the anchor alive on IPC loss too: supervisor death is lost authority,
// not permission for a replacement to reopen pipes or signal a persisted PID.
const ANCHOR_PROGRAM = String.raw`
const { spawn, execFileSync } = require("node:child_process");
const { closeSync } = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 60000);
const send = (value) => { if (process.connected) process.send(value, () => {}); };
process.once("message", ({ binary, args }) => {
	try {
		if (typeof binary !== "string" || !binary.startsWith("/") || !Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error();
		const child = spawn(binary, args, { shell: false, detached: false, stdio: [0, 1, 2] });
		child.once("error", () => send({ kind: "failed" }));
		child.once("spawn", () => {
			try {
				const birth = execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
				if (!birth || child.exitCode !== null || child.signalCode !== null) throw new Error();
				for (const fd of [0, 1, 2]) closeSync(fd);
				send({ kind: "started", child: { pid: child.pid, processStartTime: birth } });
			} catch { send({ kind: "failed" }); }
		});
		child.once("exit", (code, signal) => send({ kind: "exited", code, signal }));
	} catch { send({ kind: "failed" }); }
});
`;
