import type { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { SUMOCODE_RELOAD_EXIT_CODE } from "../../commands/reload.js";
import { boundRetainedResult } from "../../child-protocol.js";
import { defaultTerminalSessionOwner } from "../runtime/terminal-controller.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { drainChromeCacheForShutdown, type ChromeCacheWorkerClient } from "./chrome-cache-worker-client.js";
import { RpcChildExitError } from "./client.js";
import type { CachedChrome } from "./chrome-cache.js";
import type { SumoRpcClient } from "./client.js";
import type { RpcHostRuntime } from "./runtime.js";

export type RpcHostPhase = "constructing" | "child-owned" | "editor-ready" | "hydrating" | "command-ready" | "stopping" | "stopped";
type HostRuntime = Pick<RpcHostRuntime, "start" | "stop" | "waitForExit" | "adoptRetainedTerminal" | "startInput" | "markEditorReady" | "markCommandReady">;
type Finalizer = { readonly name: string; readonly run: () => void };
type TimerName = "session-hydration" | "child-exit";

interface RpcHostLifecycleOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly input: { setRawMode?(enabled: boolean): void };
	readonly stderr: Pick<NodeJS.WriteStream, "write">;
	readonly exit?: (code: number) => void;
	readonly onChildAdopted?: () => void;
	readonly signals?: Pick<EventEmitter, "on" | "removeListener">;
	readonly terminal?: Pick<typeof defaultTerminalSessionOwner, "adoptRetainedSession" | "exitTerminal">;
}

/** Owns host shutdown dependencies; domain orchestration only hands it acquired resources. */
export class RpcHostLifecycle {
	private currentPhase: RpcHostPhase = "constructing";
	private startPromise: Promise<number> | undefined;
	private stopPromise: Promise<void> | undefined;
	private code: number | undefined;
	private exited = false;
	private childOwned = false;
	private childStopFailed = false;
	private readonly resources: Finalizer[] = [];
	private readonly subscriptions: Finalizer[] = [];
	private readonly timers = new Map<TimerName, NodeJS.Timeout>();
	private statsTimer: NodeJS.Timeout | undefined;
	private gitWatcher: (() => void) | undefined;
	private treeRetry: { clear(): void } | undefined;
	private runtime: HostRuntime | undefined;
	private client: (Pick<SumoRpcClient, "stop" | "stderr"> & Partial<Pick<SumoRpcClient, "adoptedChild">>) | undefined;
	private cache: Pick<ChromeCacheWorkerClient, "write" | "dispose"> | undefined;
	private cacheCwd = "";
	private pendingChrome: CachedChrome | undefined;
	private cacheImmediate: NodeJS.Immediate | undefined;
	private lastCacheWrite: Promise<void> = Promise.resolve();
	private terminalIndexGate: string | undefined;
	private readonly signals;
	private resolveExit!: (code: number) => void;
	private readonly exitPromise = new Promise<number>((resolve) => { this.resolveExit = resolve; });
	private readonly handleSigint = () => this.shutdownAndExit(130, "SIGINT");
	private readonly handleSigterm = () => this.shutdownAndExit(0, "SIGTERM");
	private readonly handleError: (cause: unknown) => void;
	private rejectStartup: ((cause: unknown) => void) | undefined;

	public constructor(private readonly options: RpcHostLifecycleOptions) {
		this.signals = options.signals ?? process;
		const handleAdoptedError = createUnhandledRejectionHandler({
			stderr: options.stderr,
			cleanup: (code) => this.stop(code, "unhandled-error"),
			exit: (code) => this.exit(code),
		});
		this.handleError = (cause) => {
			if (this.childOwned) handleAdoptedError(cause);
			else if (!this.stopping) {
				// Both Node and native entry owners reap on startup rejection. Never
				// bypass that existing handoff by exiting while they still own Pi.
				this.rejectStartup?.(cause);
				void this.stop(1, "pre-adoption-error");
			}
		};
	}

	public get phase(): RpcHostPhase { return this.currentPhase; }
	public get stopping(): boolean { return this.currentPhase === "stopping" || this.currentPhase === "stopped"; }
	public get exitCode(): number | undefined { return this.code; }

	public start(construct: () => Promise<number>): Promise<number> {
		this.startPromise ??= this.run(construct);
		return this.startPromise;
	}

	private async run(construct: () => Promise<number>): Promise<number> {
		if (this.stopping) return this.waitForExit();
		const startupFailure = new Promise<never>((_resolve, reject) => { this.rejectStartup = reject; });
		// Both events share one teardown. A synchronous throw in the event ->
		// render path is an uncaughtException, not a rejection; when only the
		// latter was handled, such a throw left the terminal in raw mode/altscreen.
		this.signals.on("unhandledRejection", this.handleError);
		this.signals.on("uncaughtException", this.handleError);
		let code = 0;
		try {
			// Native launchers intercept process exit. They must also receive the
			// stopped result when an outstanding hydration/start operation stalls.
			code = await Promise.race([construct(), startupFailure, this.exitPromise]);
		} catch (error) {
			code = this.code ?? 1;
			// A child that died before adoption handed the outcome to the exit
			// handler: it recorded the root exit intent (this.code) and started the
			// stop pipeline ahead of this rejection. That recorded intent outranks
			// the raw rejection -- the pre-lifecycle host returned
			// requestedHostExitCode from its catch -- so fall through to it below.
			// A deliberate reload exit (100) must reach the entry's respawn loop
			// instead of surfacing as an unhandled startup crash.
			const exitHandlerOwnsOutcome = !this.childOwned
				&& error instanceof RpcChildExitError
				&& this.code !== undefined;
			// Entry still owns the pre-spawned child and retained terminal. Its
			// catch must receive startup rejection so it can reap before exiting.
			if (!this.childOwned && !exitHandlerOwnsOutcome) throw error;
			if (this.childOwned && this.code === undefined) {
				this.options.stderr.write(`[sumocode-rpc] ${error instanceof Error ? error.message : String(error)}\n`);
				if (this.client?.stderr) this.options.stderr.write(`${this.client.stderr.trim()}\n`);
			}
		} finally {
			await this.stop(code, "return");
		}
		writeExitCodeFile(this.options.env, this.code ?? code);
		return this.code ?? code;
	}

	public childAdopted(): void {
		this.advance("constructing", "child-owned");
		this.childOwned = true;
		// Arm this owner before the entry removes its listeners.
		this.signals.on("SIGINT", this.handleSigint);
		this.signals.on("SIGTERM", this.handleSigterm);
		this.options.onChildAdopted?.();
	}

	public ownClient(client: Pick<SumoRpcClient, "stop" | "stderr"> & Partial<Pick<SumoRpcClient, "adoptedChild">>, terminalIndexGate?: string): void {
		this.client = client;
		this.terminalIndexGate = terminalIndexGate;
	}

	public ownCache(cache: Pick<ChromeCacheWorkerClient, "write" | "dispose">, cwd: string): void {
		this.cache = cache;
		this.cacheCwd = cwd;
	}

	public ownResource(name: "activity" | "regions", resource: { dispose(): void }): void {
		this.register(this.resources, { name, run: () => resource.dispose() });
	}

	public ownSubscription(name: "activity" | "client-event" | "client-exit", unsubscribe: () => void): void {
		this.register(name === "activity" ? this.resources : this.subscriptions, { name, run: unsubscribe });
	}

	public ownRuntime(runtime: HostRuntime): void {
		this.runtime = runtime;
		this.register(this.resources, { name: "runtime", run: () => {
			try { runtime.stop(this.code, { preserveTerminal: this.code === SUMOCODE_RELOAD_EXIT_CODE }); }
			catch (error) {
				this.restoreTerminal();
				throw error;
			}
		} });
		void runtime.waitForExit().then((code) => this.stop(code, "runtime-exit"));
	}

	public async startRuntime(): Promise<void> {
		if (this.stopping || !this.runtime) return;
		if (this.options.env.SUMOCODE_RELOAD === "1") {
			this.runtime.adoptRetainedTerminal();
			this.runtime.startInput();
			this.runtime.markEditorReady();
			this.publishReloadReady();
		} else await this.runtime.start();
		if (!this.stopping) this.advance("child-owned", "editor-ready");
	}

	public beginHydration(): void {
		if (!this.stopping) this.advance("editor-ready", "hydrating");
	}

	public markCommandReady(): void {
		if (this.stopping) return;
		this.advance("hydrating", "command-ready");
		this.runtime?.markCommandReady();
	}

	public ownTreeRetry(scheduler: { clear(): void }): void { this.treeRetry = scheduler; }

	public ownGitWatcher(stopWatching: () => void): void {
		if (this.stopping) this.finalize({ name: "git-watcher", run: stopWatching });
		else this.gitWatcher = stopWatching;
	}

	public scheduleTimeout(name: TimerName, callback: () => void, delay: number): NodeJS.Timeout {
		this.clearTimeout(name);
		const timer = setTimeout(() => {
			this.timers.delete(name);
			if (!this.stopping) callback();
		}, delay);
		if (this.stopping) clearTimeout(timer);
		else this.timers.set(name, timer);
		timer.unref?.();
		return timer;
	}

	public clearTimeout(name: TimerName): void {
		clearTimeout(this.timers.get(name));
		this.timers.delete(name);
	}

	public startStatsPolling(refresh: () => void): void {
		if (!this.stopping && !this.statsTimer) this.statsTimer = setInterval(refresh, 5_000);
	}

	public cacheChrome(chrome: CachedChrome): void {
		if (this.currentPhase === "stopped") return;
		this.pendingChrome = { modelLabel: chrome.modelLabel, thinkingLevel: chrome.thinkingLevel };
		if (this.cacheImmediate) return;
		this.cacheImmediate = setImmediate(() => {
			this.cacheImmediate = undefined;
			this.writePendingChrome();
		});
		this.cacheImmediate.unref?.();
	}

	public waitForExit(): Promise<number> { return this.exitPromise; }

	/** First root intent wins, even when notification visibility delays cleanup. */
	public recordExitCode(code: number): void { this.code ??= code; }

	public stop(code = 0, reason = "exit"): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.recordExitCode(code);
		logDiagnostic("rpc_host_stop", { code: this.code, reason, phase: this.currentPhase });
		this.currentPhase = "stopping";
		// Publish idempotency before runtime.stop can resolve waiters or re-enter.
		let resolveStop!: () => void;
		this.stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
		void this.finalizeHost().catch((error) => this.report("host", error)).finally(() => {
			this.currentPhase = "stopped";
			this.removeListeners();
			this.resolveExit(this.code ?? code);
			resolveStop();
			// A live child keeps Node alive even with exitCode set. Entry still owns
			// pre-adoption failures; adopted failures exit only after all cleanup.
			if (this.childOwned && this.childStopFailed) this.exit(1);
		});
		return this.stopPromise;
	}

	public exit(code: number): void {
		if (this.exited) return;
		this.exited = true;
		const finalCode = this.code ?? code;
		writeExitCodeFile(this.options.env, finalCode);
		if (this.options.exit) this.options.exit(finalCode);
		else process.exit(finalCode);
	}

	private shutdownAndExit(code: number, reason: string): void {
		void this.stop(code, reason).then(() => this.exit(code));
	}

	private async finalizeHost(): Promise<void> {
		// These are dependency barriers, not constructor order: stop producers,
		// restore terminal/dispose views, reap child, then flush its last cache write.
		clearInterval(this.statsTimer);
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		if (this.treeRetry) this.finalize({ name: "tree-retry", run: () => this.treeRetry!.clear() });
		if (this.gitWatcher) this.finalize({ name: "git-watcher", run: this.gitWatcher });
		if (this.childOwned && !this.runtime && this.options.env.SUMOCODE_RELOAD === "1") this.restoreTerminal();
		for (const finalizer of this.resources.splice(0).reverse()) this.finalize(finalizer);
		try { await this.client?.stop(); } catch (error) {
			this.childStopFailed = true;
			const wasReload = this.code === SUMOCODE_RELOAD_EXIT_CODE;
			this.code = 1;
			const child = this.client?.adoptedChild;
			const evidence = { pid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null };
			logDiagnostic("rpc_host_child_reap_failed", evidence);
			this.report(`child (unreaped; identity snapshot ${JSON.stringify(evidence)})`, error);
			if (wasReload) this.restoreTerminal();
		}
		for (const finalizer of this.subscriptions.splice(0).reverse()) this.finalize(finalizer);
		if (this.terminalIndexGate) this.finalize({ name: "terminal-index-gate", run: () => rmSync(this.terminalIndexGate!, { force: true }) });
		await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
		if (this.cache) await drainChromeCacheForShutdown(() => this.flushChrome(), () => this.cache!.dispose());
		if (this.cacheImmediate) clearImmediate(this.cacheImmediate);
		this.cacheImmediate = undefined;
	}

	private register(stack: Finalizer[], finalizer: Finalizer): void {
		if (this.stopping) {
			this.finalize(finalizer);
			throw new Error("RPC host stopped during acquisition");
		}
		stack.push(finalizer);
	}

	private finalize(finalizer: Finalizer): void {
		try { finalizer.run(); } catch (error) { this.report(finalizer.name, error); }
	}

	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- finalizers can throw any value; this sink bounds its string form for diagnostics.
	private report(name: string, error: unknown): void {
		try { this.options.stderr.write(`[sumocode-rpc] ${name} cleanup failed: ${boundRetainedResult(String(error), 500)}\n`); } catch {}
	}

	private advance(from: RpcHostPhase, to: RpcHostPhase): void {
		if (this.currentPhase !== from) throw new Error(`RPC host phase ${this.currentPhase}; expected ${from} before ${to}`);
		this.currentPhase = to;
	}

	private restoreTerminal(): void {
		const terminal = this.options.terminal ?? defaultTerminalSessionOwner;
		this.finalize({ name: "raw-mode", run: () => { this.options.input.setRawMode?.(false); } });
		this.finalize({ name: "terminal-adoption", run: () => terminal.adoptRetainedSession() });
		this.finalize({ name: "terminal", run: () => terminal.exitTerminal() });
		this.publishReloadReady();
	}

	private publishReloadReady(): void {
		const path = this.options.env.SUMOCODE_RELOAD_READY_FILE;
		if (path) {
			try { writeFileSync(path, "ready", { mode: 0o600 }); } catch {}
		}
	}

	private writePendingChrome(): void {
		const chrome = this.pendingChrome;
		this.pendingChrome = undefined;
		if (chrome && this.cache) this.lastCacheWrite = this.cache.write(this.cacheCwd, chrome).catch(() => undefined);
	}

	private async flushChrome(): Promise<void> {
		for (;;) {
			if (this.cacheImmediate) clearImmediate(this.cacheImmediate);
			this.cacheImmediate = undefined;
			this.writePendingChrome();
			const write = this.lastCacheWrite;
			await write;
			if (!this.pendingChrome && this.lastCacheWrite === write) return;
		}
	}

	private removeListeners(): void {
		this.rejectStartup = undefined;
		this.signals.removeListener("SIGINT", this.handleSigint);
		this.signals.removeListener("SIGTERM", this.handleSigterm);
		this.signals.removeListener("unhandledRejection", this.handleError);
		this.signals.removeListener("uncaughtException", this.handleError);
	}
}

export interface UnhandledRejectionShutdownOptions {
	readonly stderr: Pick<NodeJS.WriteStream, "write">;
	readonly cleanup: (code: number) => Promise<void>;
	readonly exit: (code: number) => void;
}

export function createUnhandledRejectionHandler(options: UnhandledRejectionShutdownOptions): (cause: unknown) => void {
	let shutdown: Promise<void> | undefined;
	const format = (cause: unknown) => cause instanceof Error ? cause.stack ?? cause.message : String(cause);
	return (cause: unknown): void => {
		if (shutdown) return;
		shutdown = (async () => {
			options.stderr.write(`[sumocode-rpc] unhandled rejection: ${format(cause)}\n`);
			await options.cleanup(1);
			options.exit(1);
		})().catch((error) => {
			options.stderr.write(`[sumocode-rpc] unhandled rejection cleanup failed: ${format(error)}\n`);
			options.exit(1);
		});
	};
}

/**
 * Out-of-band exit code for bin/sumocode.sh's respawn loop. Verified on macOS
 * bash 3.2: a SIGTERM-graceful shutdown this host resolves as exit 0 can
 * surface through bash's `wait` as 143 (128+SIGTERM), so the launcher reads
 * this file instead of trusting the job status.
 *
 * Two constraints follow. Every host exit path must funnel through here
 * (normal return, the reload exit-100 path, each process.exit call site, both
 * signal handlers), or the launcher reads a stale code. And the write must be
 * synchronous: an async write racing process.exit can be dropped before it
 * reaches disk.
 *
 * Never throws: unset under unit tests and manual runs without the launcher,
 * which falls back to bash's own status when the file is absent.
 */
export function writeExitCodeFile(env: NodeJS.ProcessEnv, code: number): void {
	const path = env.SUMOCODE_EXIT_CODE_FILE;
	if (path) {
		try { writeFileSync(path, String(code)); } catch {}
	}
}
