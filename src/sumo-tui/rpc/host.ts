import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultActivityStateRoot } from "../../activity/persistence.js";
import { FileActivityStore, type ActivityStoreSnapshot } from "../../activity/store.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { SUMOCODE_RELOAD_EXIT_CODE } from "../../commands/reload.js";
import { containsCtrlCToken, isEscapeInput } from "../input/shared-input-router.js";
import { createOsc52Sequence } from "../input/selection.js";
import { loadYoga } from "../layout/yoga.js";
import { applyStartupTheme } from "../../themes/index.js";
import { ExtensionStatusPublication, RegionRegistry } from "../pi-compat/region-registry.js";
import type { TranscriptControllerChatSink } from "../transcript/controller.js";
import type { ChatMessageViewModel } from "../transcript/view-model.js";
import type { ChatPagerReplaceStats } from "../widgets/chat-pager.js";
import { ModalLayer } from "../widgets/modal-layer.js";
import { NotificationCenter } from "../widgets/notification.js";
import { RpcChildExitError, SumoRpcClient, truncateForNotification } from "./client.js";
import { readCachedChrome, writeCachedChrome } from "./chrome-cache.js";
import { RpcHostControls } from "./controls.js";
import { createRpcKeybindingsManager, RpcHostEditorController } from "./editor.js";
import { createRpcExtensionUiResponder } from "./extension-ui-responder.js";
import { InMemoryRpcTreeNavigationOutcomeBroker, type RpcTreeNavigationRequest } from "../pi-compat/tree-navigation-command.js";
import { RpcHostActions } from "./host-actions.js";
import { readAuthoritativeSessionSnapshot } from "./session-snapshot.js";
import type { SessionEntrySnapshot } from "./session-reader.js";
import type { RpcTreeNavigationOutcome } from "../pi-compat/tree-navigation-command.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { InlineSelectorHost } from "./inline-selector.js";
import { InitialHydrationActionGate } from "./initial-hydration-action-gate.js";
import { decideRpcInterrupt, type RpcInterruptInputKind } from "./interrupt.js";
import { readGitBranch, watchGitBranch } from "./git.js";
import { createRpcPromptScheduler, type RpcPromptScheduler } from "./prompt-scheduler.js";
import { RpcHostRuntime } from "./runtime.js";
import { responseData } from "./response.js";
import { notifyOnError, type ErrorNotifier } from "./safe-send.js";
import { RpcHostStateStore, type RpcHostChromeState } from "./state.js";
import { RpcTranscriptPump } from "./transcript-pump.js";
import { rpcVisualFixtureFromEnv } from "./visual-fixtures.js";
import { logDiagnostic } from "../runtime/diagnostics.js";

export interface RpcHostMainOptions {
	readonly argv?: readonly string[];
	readonly preSpawnedChild?: ChildProcessWithoutNullStreams;
	/** Entry ownership handoff: child lifecycle listeners are installed. */
	readonly onPreSpawnedChildAdopted?: () => void;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdout?: NodeJS.WriteStream;
	readonly stdin?: NodeJS.ReadStream;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	readonly treeNavigationQuietTiming?: RpcTreeNavigationQuietTiming;
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, line: string): void {
	stream.write(`${line}\n`);
}

function writeTerminalTitle(stream: Pick<NodeJS.WriteStream, "write">, title: string): void {
	stream.write(`\u001b]0;${title.replace(/[\x00-\x1F\x7F-\x9F]/g, "")}\u0007`);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

export const TREE_NAVIGATION_QUIET_POLL_MS = 100;
export const TREE_NAVIGATION_QUIET_DEADLINE_MS = 30_000;
export const TREE_NAVIGATION_QUIET_MAX_ATTEMPTS = 300;

export interface RpcTreeNavigationQuietTiming {
	readonly pollMs?: number;
	readonly deadlineMs?: number;
	readonly maxAttempts?: number;
	readonly now?: () => number;
	readonly wait?: (milliseconds: number) => Promise<void>;
}

export class RpcTreeNavigationQuietTimeoutError extends Error {
	public readonly attempts: number;
	public readonly elapsedMs: number;

	public constructor(attempts: number, elapsedMs: number) {
		super(`tree navigation compaction did not settle after ${attempts} attempts and ${elapsedMs}ms`);
		this.name = "RpcTreeNavigationQuietTimeoutError";
		this.attempts = attempts;
		this.elapsedMs = elapsedMs;
	}
}

function waitMs(milliseconds: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

/**
 * Waits for a tree mutation's possibly-still-running compaction to become
 * observable as idle. The bound applies only to tree reconciliation; ordinary
 * `/compact` requests retain their existing client timeout and semantics.
 */
export async function waitForTreeNavigationQuiet(
	refreshState: () => Promise<Pick<RpcHostChromeState, "isCompacting">>,
	timing: RpcTreeNavigationQuietTiming = {},
): Promise<void> {
	const pollMs = Math.max(0, timing.pollMs ?? TREE_NAVIGATION_QUIET_POLL_MS);
	const deadlineMs = Math.max(0, timing.deadlineMs ?? TREE_NAVIGATION_QUIET_DEADLINE_MS);
	const maxAttempts = Math.max(1, Math.floor(timing.maxAttempts ?? TREE_NAVIGATION_QUIET_MAX_ATTEMPTS));
	const now = timing.now ?? Date.now;
	const wait = timing.wait ?? waitMs;
	const startedAt = now();
	let attempts = 0;
	for (;;) {
		attempts += 1;
		const state = await refreshState();
		if (!state.isCompacting) return;
		const elapsedMs = Math.max(0, now() - startedAt);
		if (attempts >= maxAttempts || elapsedMs >= deadlineMs) {
			throw new RpcTreeNavigationQuietTimeoutError(attempts, elapsedMs);
		}
		await wait(Math.min(pollMs, Math.max(0, deadlineMs - elapsedMs)));
	}
}

export interface RpcSameSessionTreeNavigationHydrationDependencies {
	readonly waitForQuiet: () => Promise<void>;
	readonly markHydrationBaseline: () => void;
	readonly markHydrationBarrier: () => void;
	readonly hasEventsAfterHydrationBarrier: () => boolean;
	readonly refreshState: () => Promise<RpcHostChromeState>;
	readonly readMessages: () => Promise<readonly unknown[]>;
	readonly readSnapshot: () => Promise<SessionEntrySnapshot>;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}

export interface RpcSameSessionTreeNavigationHydration {
	readonly state: RpcHostChromeState;
	readonly messages?: readonly unknown[];
	readonly snapshot?: SessionEntrySnapshot;
	readonly identityChanged: boolean;
}

/**
 * Hydrates a tree mutation against the existing session owner. This is kept
 * separate from replacement hydration so a transient message/snapshot read
 * can be retried without rebinding the scheduler, activity feed, or runtime.
 */
export async function hydrateSameSessionTreeNavigation(
	deps: RpcSameSessionTreeNavigationHydrationDependencies,
): Promise<RpcSameSessionTreeNavigationHydration> {
	await deps.waitForQuiet();
	deps.markHydrationBaseline();
	let state: RpcHostChromeState | undefined;
	let messages: readonly unknown[] | undefined;
	let snapshot: SessionEntrySnapshot | undefined;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		deps.markHydrationBarrier();
		state = await deps.refreshState();
		const identityChanged = state.sessionId !== deps.sessionId || state.sessionFile !== deps.sessionFile;
		if (identityChanged) return { state, identityChanged: true };
		messages = await deps.readMessages();
		snapshot = await deps.readSnapshot();
		if (!deps.hasEventsAfterHydrationBarrier()) {
			deps.markHydrationBarrier();
			break;
		}
	}
	if (!state || !messages || !snapshot) throw new Error("tree navigation hydration did not produce a snapshot");
	return { state, messages, snapshot, identityChanged: false };
}

export interface RpcTreeNavigationRetryScheduler {
	schedule(operation: () => Promise<void>): boolean;
	clear(): void;
}

/** Owns the delayed same-session retry timer and prevents duplicate recovery passes. */
export function createRpcTreeNavigationRetryScheduler(delayMs = 100): RpcTreeNavigationRetryScheduler {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		schedule(operation): boolean {
			if (timer) return false;
			timer = setTimeout(() => {
				timer = undefined;
				void operation().catch(() => undefined);
			}, delayMs);
			timer.unref?.();
			return true;
		},
		clear(): void {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

function treeSummaryMode(request: { readonly summarize: boolean; readonly customInstructions?: string }): "none" | "default" | "custom" {
	if (!request.summarize) return "none";
	return request.customInstructions === undefined ? "default" : "custom";
}

export interface UnhandledRejectionShutdownOptions {
	readonly stderr: Pick<NodeJS.WriteStream, "write">;
	readonly cleanup: (code: number) => Promise<void>;
	readonly exit: (code: number) => void;
}

export function createUnhandledRejectionHandler(options: UnhandledRejectionShutdownOptions): (reason: unknown) => void {
	let shutdown: Promise<void> | undefined;
	return (reason: unknown): void => {
		if (shutdown) return;
		shutdown = (async () => {
			writeLine(options.stderr, `[sumocode-rpc] unhandled rejection: ${formatUnknownError(reason)}`);
			await options.cleanup(1);
			options.exit(1);
		})().catch((error) => {
			writeLine(options.stderr, `[sumocode-rpc] unhandled rejection cleanup failed: ${formatUnknownError(error)}`);
			options.exit(1);
		});
	};
}

function hostRoot(env: NodeJS.ProcessEnv): string {
	return resolve(env.SUMOCODE_ROOT_DIR ?? process.cwd());
}

function hostCwd(env: NodeJS.ProcessEnv): string {
	return resolve(env.SUMOCODE_PROJECT_CWD ?? process.cwd());
}

function piBinary(env: NodeJS.ProcessEnv): string {
	const pi = env.PI_BIN;
	if (!pi) throw new Error("SUMO_RPC host requires PI_BIN to be set by bin/sumocode.sh");
	return pi;
}

type ChildSpawnPlan = {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
};

const requireFromRuntime = createRequire(import.meta.url);
const { buildChildSpawnPlan } = requireFromRuntime("./spawn-child.mjs") as {
	buildChildSpawnPlan(env: NodeJS.ProcessEnv, argv: readonly string[]): ChildSpawnPlan | undefined;
};

/**
 * Writes this host process's final exit code to the out-of-band file
 * bin/sumocode.sh points at via SUMOCODE_EXIT_CODE_FILE, so the launcher's
 * respawn loop can read the host's REAL exit code instead of trusting bash
 * 3.2's `wait`-based recovery (`wait_for_child_exit` in bin/sumocode.sh),
 * which was verified unreliable in this environment: a SIGTERM-graceful
 * shutdown that this host resolves as exit 0 was observed surfacing to the
 * launcher as 143 (128+SIGTERM) instead, because the backgrounded job's
 * status as bash's `wait` builtin reports it does not always reflect the
 * process's own chosen exit code on a graceful signal-triggered shutdown path
 * under macOS bash 3.2.
 *
 * This is the SINGLE choke point every host exit path funnels through
 * (normal return via main(), the reload exit-100 path, every
 * process.exit(...) call site, and both signal handlers) -- see runRpcHost
 * and main() below for each call site. Synchronous by design: an async write
 * racing a subsequent process.exit(code) could be truncated or dropped
 * entirely before it reaches disk.
 *
 * Silently no-ops (never throws) when the env var is unset (e.g. under
 * vitest/unit tests that construct runRpcHost's dependencies directly,
 * pre-existing manual runs of sumo-rpc-host.js without the launcher, or a
 * write failure) -- this is a best-effort side channel the launcher falls
 * back away from when absent or unparseable, never a hard requirement for
 * the host to actually exit.
 */
export function writeExitCodeFile(env: NodeJS.ProcessEnv, code: number): void {
	const path = env.SUMOCODE_EXIT_CODE_FILE;
	if (!path) return;
	try {
		writeFileSync(path, String(code));
	} catch {
		// Best-effort; the launcher falls back to bash's own wait status.
	}
}

function activityPresentation(snapshot: ActivityStoreSnapshot) {
	return {
		activities: snapshot.activities,
		expansion: snapshot.expansion,
		...(snapshot.defaultExpansion === undefined ? {} : { defaultExpansion: snapshot.defaultExpansion }),
	};
}

export function activitySnapshotMatchesSession(snapshot: ActivityStoreSnapshot, sessionId: string | undefined): boolean {
	return snapshot.ownerSessionId === sessionId;
}

/**
 * Buffers every child event from the session-operation barrier until RPC state
 * and messages have hydrated. Events before the post-mutation barrier are
 * superseded by destination snapshots; replaying the ordered post-barrier
 * suffix is safe because transcript events carry stable IDs and agent_end is a
 * complete replacement, while dropping that suffix leaves settled state stale.
 */
export interface RpcHydrationEventReplay {
	readonly supersededSnapshotEvents: readonly AgentSessionEvent[];
	readonly suffixEvents: readonly AgentSessionEvent[];
}

export class RpcSessionEventBuffer {
	private events: AgentSessionEvent[] = [];
	private replayStart = 0;
	private failureReplayStart = 0;
	private active = false;

	public get isActive(): boolean {
		return this.active;
	}

	public begin(): boolean {
		if (this.active) return false;
		this.events = [];
		this.replayStart = 0;
		this.failureReplayStart = 0;
		this.active = true;
		return true;
	}

	public capture(event: AgentSessionEvent): boolean {
		if (!this.active) return false;
		this.events.push(event);
		return true;
	}

	/** Old-session events before this point are excluded even if hydration later fails. */
	public markHydrationBaseline(): void {
		if (!this.active) return;
		this.replayStart = this.events.length;
		this.failureReplayStart = this.events.length;
	}

	/** Events before this point are covered by a complete destination hydration pass. */
	public markHydrationBarrier(): void {
		if (this.active) this.replayStart = this.events.length;
	}

	public get hasEventsAfterHydrationBarrier(): boolean {
		return this.active && this.events.length > this.replayStart;
	}

	public finish(options: { readonly afterHydrationBarrier?: boolean; readonly afterFailureBaseline?: boolean } = {}): readonly AgentSessionEvent[] {
		const events = options.afterHydrationBarrier
			? this.events.slice(this.replayStart)
			: options.afterFailureBaseline
				? this.events.slice(this.failureReplayStart)
				: this.events;
		this.reset();
		return events;
	}

	public finishHydration(): RpcHydrationEventReplay {
		const replay = {
			supersededSnapshotEvents: this.events.slice(this.failureReplayStart, this.replayStart),
			suffixEvents: this.events.slice(this.replayStart),
		};
		this.reset();
		return replay;
	}

	private reset(): void {
		this.events = [];
		this.replayStart = 0;
		this.failureReplayStart = 0;
		this.active = false;
	}
}

function fallbackChatSinkStats(messages: readonly ChatMessageViewModel[]): ChatPagerReplaceStats {
	return {
		sourceMessages: messages.length,
		acceptedMessages: messages.length,
		renderedMessages: messages.length,
		archivedMessages: 0,
	};
}

/**
 * A `TranscriptControllerChatSink` that forwards to whatever
 * `RpcHostRuntime.getChatSink()` currently returns. Needed because
 * `RpcTranscriptPump` (which owns the `TranscriptController` that this sink
 * is attached to at construction time, see `TranscriptControllerOptions.chat`)
 * is created synchronously near the top of `runRpcHost`, well before
 * `RpcHostRuntime` (and its async `RpcShellAdapter.create`, which happens
 * after `client.start()`) exists at all. Before the runtime/adapter exist,
 * writes are no-ops -- any events the controller processes in that window
 * still update its OWN internal state correctly (see `TranscriptController`),
 * they just have no live pager to push into yet; the adapter's constructor
 * separately seeds the pager from `initialTranscript` once it IS created
 * (from a `transcriptPump.replaceFromMessages` snapshot taken right before),
 * so nothing from that narrow startup window is lost, only deferred to the
 * normal hydration path.
 */
export function createLazyChatSink(getRuntime: () => { getChatSink(): TranscriptControllerChatSink | undefined } | undefined): TranscriptControllerChatSink {
	return {
		replaceViewModels: (messages, options) => {
			const sink = getRuntime()?.getChatSink();
			if (!sink) return fallbackChatSinkStats(messages);
			return options === undefined ? sink.replaceViewModels(messages) : sink.replaceViewModels(messages, options);
		},
		addViewModel: (message, sourceIndex) => {
			const sink = getRuntime()?.getChatSink();
			return sourceIndex === undefined ? sink?.addViewModel(message) : sink?.addViewModel(message, sourceIndex);
		},
		replaceViewModelAt: (index, message) => getRuntime()?.getChatSink()?.replaceViewModelAt(index, message),
		replaceLastWithViewModel: (message, sourceIndex) => {
			const sink = getRuntime()?.getChatSink();
			return sourceIndex === undefined
				? sink?.replaceLastWithViewModel(message)
				: sink?.replaceLastWithViewModel(message, sourceIndex);
		},
	};
}

export interface RpcPromptSubmitOptions {
	readonly visualFixture?: unknown;
	readonly scheduler?: Pick<RpcPromptScheduler, "submit">;
	readonly actions?: Pick<RpcHostActions, "handleSubmittedText">;
	readonly stateStore?: Pick<RpcHostStateStore, "getSnapshot">;
	readonly client: Pick<SumoRpcClient, "send">;
	readonly onBeforeSend?: (message: string) => void;
}

export async function submitRpcPrompt(message: string, options: RpcPromptSubmitOptions): Promise<void> {
	if (options.visualFixture) return;
	if (message.trim().length === 0) return;
	if (options.scheduler) {
		await options.scheduler.submit(message);
		return;
	}
	if (await options.actions?.handleSubmittedText(message)) return;
	options.onBeforeSend?.(message);
	responseData(await options.client.send({ type: "prompt", message }), "prompt");
}

/**
 * Submits `SUMOCODE_INITIAL_PROMPT` (set by `bin/sumocode.sh` when a task/
 * prompt positional was destined for `pi --mode rpc`, which never reads argv
 * positionals -- only InteractiveMode does; rpc-mode.js reads only stdin JSON
 * commands) via `submit`, the SAME function the host wires as the editor's
 * `onSubmit` (see `submitFromEditor` in `runRpcHost`), so streaming state,
 * transcript, and interrupt flags all engage exactly as they would for a real
 * editor submit instead of the prompt silently vanishing.
 *
 * A no-op when the env var is absent or blank -- the common case for every
 * launch that isn't `sumocode <prompt>` / `sumocode task <prompt>`.
 */
export async function submitInitialPromptFromEnv(env: NodeJS.ProcessEnv, submit: (message: string) => Promise<void>): Promise<void> {
	const message = env.SUMOCODE_INITIAL_PROMPT;
	if (!message) return;
	await submit(message);
}

export interface RpcMessageFollowUpDependencies {
	readonly editor: Pick<RpcHostEditorController, "getText" | "addToHistory" | "setText" | "expandDraftTokens" | "clearImageDrafts">;
	readonly scheduler: Pick<RpcPromptScheduler, "getSnapshot" | "submit">;
	readonly notifications: ErrorNotifier;
	readonly isBlocked?: () => boolean;
}

export function handleRpcMessageFollowUp(deps: RpcMessageFollowUpDependencies): void {
	void notifyOnError(async () => {
		if (deps.isBlocked?.() === true) {
			deps.notifications.notify("branch summary in progress", "warning");
			return;
		}
		const draft = deps.editor.getText();
		if (draft.trim().length === 0) return;
		if (!deps.scheduler.getSnapshot().busy) return;
		// Queue the EXPANDED submission (pasted [Image N] tokens → temp paths),
		// mirroring the Enter-submit wrapper — a raw draft would deliver the
		// literal token once drained. Expansion is capture-only here; the draft
		// state is cleared ONLY after the queue accepts, because a busy→idle
		// race can return "ignored" and the untouched draft must stay editable.
		const submission = deps.editor.expandDraftTokens(draft);
		const result = await deps.scheduler.submit(submission, { forceQueue: true });
		if (result !== "queued" && result !== "handled") return;
		deps.editor.addToHistory(draft);
		deps.editor.setText("");
		deps.editor.clearImageDrafts();
	}, deps.notifications);
}

export interface RpcMessageDequeueDependencies {
	readonly editor: Pick<RpcHostEditorController, "getText" | "setText">;
	readonly scheduler: Pick<RpcPromptScheduler, "restoreAll">;
	readonly stateStore: Pick<RpcHostStateStore, "getSnapshot">;
	readonly notifications: Pick<NotificationCenter, "notify">;
}

export function handleRpcMessageDequeue(deps: RpcMessageDequeueDependencies): void {
	const restored = deps.scheduler.restoreAll(deps.editor.getText());
	if (restored.count > 0) {
		deps.editor.setText(restored.text);
		return;
	}
	if ((deps.stateStore.getSnapshot().queuedMessages?.length ?? 0) > 0) deps.notifications.notify("queued messages are owned by pi", "info");
}

export interface RpcHostExitDependencies {
	readonly modals: Pick<ModalLayer, "close">;
	readonly overlays: Pick<RpcHostOverlayManager, "drain">;
	/** Closed alongside modals/overlays -- see `RpcHostInterruptDependencies.selector`'s doc comment for why the inline selector needs the same fail-safe treatment. */
	readonly selector?: Pick<InlineSelectorHost, "close">;
	readonly stateStore: Pick<RpcHostStateStore, "getSnapshot">;
	readonly notifications: Pick<NotificationCenter, "notify">;
	readonly requestRender: () => void;
	readonly stopHost: (code: number) => Promise<void>;
	readonly exit: (code: number) => void;
	readonly updateRuntimeState: (state: RpcHostChromeState) => void;
	readonly setTimeout?: typeof setTimeout;
	readonly shutdownDelayMs?: number;
	readonly exitCode?: number;
}

/**
 * Builds the RPC host's `client.onExit` handler as an injectable function of
 * its dependencies, mirroring `createRpcHostInterruptHandler` below: the RPC
 * child is the whole agent, so if it dies outside of a deliberate stop() the
 * host cannot keep functioning. Closing modals via their normal close() path
 * and draining overlays resolves any pending overlay/select/input promises
 * without promoting queued overlay work during crash teardown.
 *
 * Exit code SUMOCODE_RELOAD_EXIT_CODE (100) is a deliberate `/sumo:reload`
 * (src/commands/reload.ts: the RPC child process.exit(100)s itself), not a
 * crash -- see `RpcChildExitError` in client.ts for how that code reaches
 * here structurally instead of via message-parsing. bin/sumocode.sh's respawn
 * loop only re-launches on THIS process (the host) exiting 100, so the host
 * must propagate that same code and skip the scary "exited unexpectedly"
 * notification, which would otherwise flash on every routine reload.
 *
 * For any other exit, the runtime is stopped with a nonzero exit code after a
 * short delay so the terse notification is actually visible before the
 * terminal is restored -- a zombie shell with a dead child behind it cannot
 * do anything useful, so keeping it alive indefinitely is not an option.
 */
export function createRpcExitHandler(deps: RpcHostExitDependencies): (error: Error) => void {
	const scheduleTimeout = deps.setTimeout ?? setTimeout;
	const shutdownDelayMs = deps.shutdownDelayMs ?? 750;
	const exitCode = deps.exitCode ?? 1;
	return (error: Error): void => {
		const reloadCode = error instanceof RpcChildExitError && error.code === SUMOCODE_RELOAD_EXIT_CODE ? error.code : undefined;
		deps.modals.close();
		deps.overlays.drain();
		deps.selector?.close();
		deps.updateRuntimeState({ ...deps.stateStore.getSnapshot(), isStreaming: false, isCompacting: false });
		if (reloadCode === undefined) {
			deps.notifications.notify(`RPC child exited unexpectedly: ${truncateForNotification(error.message)}`, "error", 0);
		}
		deps.requestRender();
		if (reloadCode !== undefined) {
			// Deliberate reload: exit the host itself with the same code right
			// away (no shutdown delay -- there is no scary notification to give
			// time to render) so bin/sumocode.sh's respawn loop sees exit 100 and
			// relaunches with --continue.
			void deps.stopHost(reloadCode).then(() => deps.exit(reloadCode));
			return;
		}
		const timer = scheduleTimeout(() => {
			void deps.stopHost(exitCode).then(() => deps.exit(exitCode));
		}, shutdownDelayMs);
		(timer as { unref?: () => void }).unref?.();
	};
}

export interface RpcHostInterruptDependencies {
	readonly modals: Pick<ModalLayer, "getActiveKind" | "close">;
	readonly overlays: Pick<RpcHostOverlayManager, "getActiveKind" | "close">;
	/**
	 * The in-place selector surface (plan 036's `InlineSelectorHost`) that
	 * occupies the editor slot for `/model`, `/thinking`, `/sessions`,
	 * `/settings`, and `/fork`. It is neither `modals` nor `overlays` (it
	 * mounts in the editor's Yoga leaf, not the modal/overlay stack -- see
	 * `inline-selector.ts`), so without this it would be invisible to
	 * `decideRpcInterrupt`: a Ctrl-C/Escape while a selector is open would
	 * fall through to the streaming-abort/arm-quit tiers instead of just
	 * dismissing the selector, a behavior the old `ModalLayer`-backed
	 * `modals.select(...)` call sites got for free via `modalActive`.
	 * Optional so existing callers/tests that construct this handler without
	 * ever mounting a selector (or before plan 036) keep working unchanged.
	 */
	readonly selector?: Pick<InlineSelectorHost, "getActiveKind" | "close">;
	readonly editor: Pick<RpcHostEditorController, "getText" | "setText" | "isAutocompleteOpen">;
	readonly stateStore: Pick<RpcHostStateStore, "getSnapshot">;
	readonly controls: Pick<RpcHostControls, "abort">;
	readonly abortInFlight?: () => Promise<void>;
	readonly notifications: Pick<NotificationCenter, "notify">;
	readonly requestHostExit: (code: number) => void;
	/**
	 * True in the window between a prompt submission and the RPC child's
	 * `agent_start` event, when `stateStore`'s `isStreaming` bit has not yet
	 * flipped. Without this, a Ctrl-C sent in that window is treated as the
	 * pre-streaming arm-quit tier instead of an abort.
	 */
	readonly submitInFlight?: () => boolean;
	/** Branch-summary mutation owns the session while its outcome is reconciled. */
	readonly isTreeNavigationBusy?: () => boolean;
	readonly restoreQueuedDrafts?: () => void;
	readonly now?: () => number;
}

/**
 * Builds the RPC host's pre-editor Ctrl-C/Escape handler as an injectable
 * function of its dependencies, factored out of `runRpcHost`'s closure so
 * the interrupt-decision wiring (which state each input kind reads, and
 * what each decision does) can be unit tested without booting the full host.
 */
export function createRpcHostInterruptHandler(deps: RpcHostInterruptDependencies): (data: string) => boolean {
	const now = deps.now ?? Date.now;
	let armedQuitUntil: number | undefined;
	const inputKind = (data: string): RpcInterruptInputKind | undefined => {
		// containsCtrlCToken (not a raw substring/equality test): `data` may be
		// a coalesced multi-token stdin chunk, and must only classify as
		// ctrl-c when a discrete Ctrl-C key token is actually present -- never
		// because pasted content happens to contain a literal 0x03 byte.
		if (containsCtrlCToken(data)) return "ctrl-c";
		if (isEscapeInput(data)) return "escape";
		return undefined;
	};
	return (data: string): boolean => {
		const kind = inputKind(data);
		if (!kind) return false;
		// Ctrl-C/Escape are consumed while an in-place tree mutation owns the
		// session. In particular, do not run the normal abort/quit tiers after
		// queued drafts have been restored for the mutation.
		if (deps.isTreeNavigationBusy?.() === true) return true;
		const nowMs = now();
		const modalActive = deps.modals.getActiveKind() !== undefined;
		const overlayActive = deps.overlays.getActiveKind() !== undefined;
		const selectorActive = deps.selector?.getActiveKind() !== undefined;
		const isStreaming = deps.stateStore.getSnapshot().isStreaming || deps.submitInFlight?.() === true;
		const decision = decideRpcInterrupt(kind, {
			// `decideRpcInterrupt` only distinguishes "some modal-ish surface is
			// active" (-> dismiss-modal) from "nothing is" -- it never reads
			// modalActive/overlayActive individually to pick between them, so
			// folding selectorActive into modalActive here is safe and keeps
			// the pure decision function's tested contract untouched.
			modalActive: modalActive || selectorActive,
			overlayActive,
			draftNonEmpty: deps.editor.getText().trim().length > 0,
			isStreaming,
			autocompleteOpen: deps.editor.isAutocompleteOpen(),
			armedUntil: armedQuitUntil,
			now: nowMs,
		});
		switch (decision) {
			case "dismiss-modal":
				armedQuitUntil = undefined;
				if (selectorActive) deps.selector?.close();
				else if (modalActive) deps.modals.close();
				else deps.overlays.close();
				return true;
			case "clear-draft":
				armedQuitUntil = undefined;
				deps.editor.setText("");
				return true;
			case "abort":
				armedQuitUntil = undefined;
				deps.restoreQueuedDrafts?.();
				void notifyOnError(async () => {
					if (deps.abortInFlight) await deps.abortInFlight();
					else await deps.controls.abort();
				}, deps.notifications);
				return true;
			case "arm-quit":
				armedQuitUntil = nowMs + 1_500;
				deps.notifications.notify("press ctrl-c again to quit", "info");
				return true;
			case "quit":
				armedQuitUntil = undefined;
				deps.requestHostExit(130);
				return true;
			case "pass":
				return false;
		}
	};
}

export interface RpcHostModelCycleDependencies {
	readonly controls: Pick<RpcHostControls, "getEnabledModels" | "setModel">;
	readonly notifications: Pick<NotificationCenter, "notify">;
	readonly onStateChange?: (state?: RpcHostChromeState) => void;
}

async function applyModelCycleStep(deps: RpcHostModelCycleDependencies, direction: -1 | 1): Promise<void> {
	const models = await deps.controls.getEnabledModels();
	if (models.length <= 1) {
		if (models.length === 0) deps.notifications.notify("no models available", "warning");
		return;
	}
	const activeIndex = models.findIndex((model) => model.active);
	const baseIndex = activeIndex < 0 ? 0 : activeIndex;
	const nextIndex = (baseIndex + direction + models.length) % models.length;
	const next = models[nextIndex];
	const state = await deps.controls.setModel(next.provider, next.id);
	deps.onStateChange?.(state);
}

/**
 * Builds the `app.model.cycleForward` (Ctrl+P by default) action handler.
 * Forward and backward cycling both step through the host-resolved
 * enabledModels list so the hotkeys and `/model` selector share one visible
 * ring. The footer reflects the model change, so this handler deliberately
 * stays toast-free on success.
 */
export function createModelCycleForwardHandler(deps: RpcHostModelCycleDependencies): () => void {
	return (): void => {
		void notifyOnError(async () => {
			await applyModelCycleStep(deps, 1);
		}, deps.notifications);
	};
}

/**
 * Builds the `app.model.cycleBackward` (Shift+Ctrl+P by default) action
 * handler. Pi's `cycle_model` RPC command is forward-only and scoped state is
 * private to the child, so the host computes the previous enabled model
 * locally and applies it with exactly one `set_model` RPC call. A single-model
 * list (N<=1) is a no-op: there is nowhere else to cycle to. If `active`
 * matches nothing (stale/renamed current model), backward falls back from the
 * first entry to the last entry, mirroring Pi's scoped-cycle behavior.
 */
export function createModelCycleBackwardHandler(deps: RpcHostModelCycleDependencies): () => void {
	return (): void => {
		void notifyOnError(async () => {
			await applyModelCycleStep(deps, -1);
		}, deps.notifications);
	};
}

export interface RpcHostThinkingCycleDependencies {
	readonly controls: Pick<RpcHostControls, "cycleThinkingLevel">;
	readonly notifications: Pick<NotificationCenter, "notify">;
	readonly onStateChange?: (state?: RpcHostChromeState) => void;
}

/**
 * Builds the `app.thinking.cycle` (Shift+Tab by default) action handler --
 * one of the two exact chords the user's diagnostic capture showed as dead
 * (pressed repeatedly, routed to "editor", no effect). Calls the same
 * `cycleThinkingLevel()` RPC command `/thinking` with no args falls back to,
 * then hands the returned state to the caller. The footer reflects the
 * thinking level, so success stays toast-free.
 */
export function createThinkingCycleHandler(deps: RpcHostThinkingCycleDependencies): () => void {
	return (): void => {
		void notifyOnError(async () => {
			const state = await deps.controls.cycleThinkingLevel();
			deps.onStateChange?.(state);
		}, deps.notifications);
	};
}

export interface RpcHostToolsExpandDependencies {
	readonly toggleActivityExpansion: () => unknown;
	readonly requestRender: () => void;
}

/** Builds `app.tools.expand` without duplicating presentation state in the host. */
export function createToolsExpandToggleHandler(deps: RpcHostToolsExpandDependencies): () => void {
	return (): void => {
		deps.toggleActivityExpansion();
		deps.requestRender();
	};
}

export async function runRpcHost(options: RpcHostMainOptions = {}): Promise<number> {
	const argv = [...(options.argv ?? process.argv.slice(2))];
	const env = options.env ?? process.env;
	// Pin pi-tui's terminal image capability OFF for the host: the retained
	// CellBuffer renderer diffs styled cells and cannot pass Kitty/iTerm2
	// graphics escape sequences through (verified: the APC payload is
	// stripped, leaving a blank hole where auto-detection promised pixels).
	// With images:null, pi-tui's Image component renders its `[Image: …]`
	// fallback chip deterministically instead. Lift this once the renderer
	// grows a graphics-passthrough overlay pass (see plans/inline-images).
	setCapabilities({ ...getCapabilities(), images: null });
	const stdout = options.stdout ?? process.stdout;
	const stdin = options.stdin ?? process.stdin;
	const stderr = options.stderr ?? process.stderr;
	// Every host exit path funnels its final code through this one closure --
	// see writeExitCodeFile's doc comment for why the launcher needs this
	// out-of-band signal instead of trusting bash 3.2's `wait`-based recovery.
	// Wraps process.exit itself (rather than being threaded through each
	// dependency-injection object below) so this is the single place that can
	// never be bypassed by a new exit call site added later.
	const exitProcess = (code: number): void => {
		writeExitCodeFile(env, code);
		process.exit(code);
	};
	if (stdout.isTTY !== true) {
		writeExitCodeFile(env, 70);
		writeLine(stderr, "[sumocode-rpc] RPC host requires a TTY; use node-pty or an interactive terminal.");
		return 70;
	}
	const root = hostRoot(env);
	const cwd = hostCwd(env);
	// Resolve and apply the configured theme before the runtime/shell is
	// constructed so the host's first frame already renders the user's theme
	// instead of the registry default (Cathedral). The RPC child process never
	// renders, so main's extension.ts theme-init (which the child also runs)
	// has no visible effect here — the host must apply it independently, via
	// the same shared resolution `extension.ts` uses.
	applyStartupTheme({ cwd });
	const visualFixture = rpcVisualFixtureFromEnv(env);
	const spawnPlan = buildChildSpawnPlan(env, argv);
	const client = new SumoRpcClient({
		command: spawnPlan?.command ?? piBinary(env),
		args: spawnPlan?.args ?? [],
		cwd: spawnPlan?.cwd ?? cwd,
		env: spawnPlan?.env,
		preSpawnedChild: options.preSpawnedChild,
	});
	let runtime: RpcHostRuntime | undefined;
	// The B9 diffing chat sink: `TranscriptController` (owned by
	// `transcriptPump`) is constructed here, before `runtime`/its
	// `RpcShellAdapter` exist (that happens async, later, after
	// `client.start()`) -- see `createLazyChatSink`'s doc comment for why
	// this indirection is needed instead of passing the pager directly.
	const transcriptPump = new RpcTranscriptPump({
		chat: createLazyChatSink(() => runtime),
		scheduleRender: () => runtime?.requestRender(),
	});
	const stateStore = new RpcHostStateStore();
	const activityStore = new FileActivityStore({
		rootDir: defaultActivityStateRoot(env),
		onDiagnostic: (diagnostic) => logDiagnostic("activity_store_diagnostic", { ...diagnostic }),
	});
	let latestActivitySnapshot = activityStore.getSnapshot();
	let deferActivityRuntimeUpdate = false;
	const sessionEvents = new RpcSessionEventBuffer();
	let treeNavigationBusy = false;
	interface TreeNavigationCapture {
		readonly request: RpcTreeNavigationRequest;
		readonly sessionId?: string;
		readonly sessionFile?: string;
		readonly leafId: string | null;
		readonly editorText: string;
		readonly messages: readonly unknown[];
		readonly pagerState: ReturnType<typeof transcriptPump.getLiveStateSnapshot>;
		readonly pagerRevision: number;
		readonly startedAt: number;
	}
	let treeNavigationCapture: TreeNavigationCapture | undefined;
	const unsubscribeActivityStore = activityStore.subscribe((snapshot) => {
		const rpcSessionId = stateStore.getSnapshot().sessionId;
		if (!activitySnapshotMatchesSession(snapshot, rpcSessionId)) return;
		latestActivitySnapshot = snapshot;
		logDiagnostic("rpc_activity_owner_observed", {
			rpcSessionId: rpcSessionId ?? null,
			feedOwnerSessionId: snapshot.ownerSessionId ?? null,
			activityCount: snapshot.activities.length,
		});
		if (!deferActivityRuntimeUpdate) runtime?.update({ activities: activityPresentation(snapshot) });
	});
	const requestRender = (): void => runtime?.requestRender();
	const pushState = (state?: RpcHostChromeState): void => {
		runtime?.update({ state: state ?? stateStore.getSnapshot() });
	};
	const cacheChromeState = (state: RpcHostChromeState): void => {
		if (visualFixture) return;
		writeCachedChrome(cwd, {
			modelLabel: state.modelLabel,
			thinkingLevel: state.thinkingLevel,
		});
	};
	const pushStateAndCacheChrome = (state?: RpcHostChromeState): void => {
		pushState(state);
		// Controls invoke pushState optimistically before the child confirms a
		// model/thinking change. Persist only callbacks carrying the successful
		// authoritative response, never an optimistic or failed intermediate.
		if (state !== undefined) cacheChromeState(state);
	};
	const treeNavigationOutcomeBroker = new InMemoryRpcTreeNavigationOutcomeBroker();
	const controls = new RpcHostControls(client, stateStore, { onOptimisticChange: pushState, treeNavigationOutcomeBroker });
	let stopHost: (code: number) => Promise<void> = async (code: number): Promise<void> => {
		runtime?.stop(code);
		await client.stop();
	};
	const handleUnhandledRejection = createUnhandledRejectionHandler({
		stderr,
		cleanup: (code) => stopHost(code),
		exit: exitProcess,
	});
	process.on("unhandledRejection", handleUnhandledRejection);
	// A synchronous throw from the event -> render path (e.g. a listener
	// registered via client.onEvent, which runs transcript ingestion + a full
	// render synchronously) is an uncaughtException, not an unhandledRejection
	// -- Plan 025 only installed the latter, so a sync throw there had no
	// terminal-restoring handler at all and could leave the terminal in raw
	// mode / altscreen after the process died. Reuse the exact same handler
	// (same stop()-then-exit(1) path, same duplicate-event guard) for both
	// events so a sync throw and an async rejection are torn down identically.
	process.once("uncaughtException", handleUnhandledRejection);
	const hostTerminal = {
		get columns(): number {
			return Math.max(1, stdout.columns ?? 80);
		},
		get rows(): number {
			return Math.max(1, stdout.rows ?? 24);
		},
		setTitle(title: string): void {
			writeTerminalTitle(stdout, title);
		},
	};
	const regionRegistry = new RegionRegistry({
		yoga: await loadYoga(),
		tui: { requestRender, terminal: hostTerminal } as never,
		theme: {} as never,
		editorTheme: { borderColor: (value: string) => value, selectList: {} } as never,
		keybindings: {} as never,
		onChange: requestRender,
	});
	const statusPublication = new ExtensionStatusPublication();
	regionRegistry.mountStatus(statusPublication.component);
	const modals = new ModalLayer({
		onChange: requestRender,
		getTerminalSize: () => ({ columns: hostTerminal.columns, rows: hostTerminal.rows }),
		copyText: (text) => runtime?.writeClipboardSequence(createOsc52Sequence(text)) ?? false,
	});
	const overlays = new RpcHostOverlayManager(requestRender);
	const notifications = new NotificationCenter({ onChange: requestRender });
	let actions: RpcHostActions | undefined;
	let regionRegistryDisposed = false;
	let requestHostExit: (code: number) => void = () => undefined;
	// Forward reference: the editor's `onInterrupt` callback (registered below,
	// on construction) must route `app.interrupt` through the same interrupt
	// tier module Ctrl-C/Escape already use (`createRpcHostInterruptHandler`,
	// built further down once its own dependencies -- including `editor`
	// itself -- exist). `app.interrupt`'s default key is Escape, so replaying
	// a canonical escape token into that handler reuses its existing
	// modal/overlay/streaming/autocomplete decision logic instead of
	// duplicating it -- this stays correct even when the user has remapped
	// `app.interrupt` to a different key, since by the time `onInterrupt`
	// fires pi's own manager has already confirmed that binding was pressed.
	let handleAppInterrupt: () => void = () => undefined;
	const paintDispatchStart = (): void => {
		const state = stateStore.getSnapshot();
		runtime?.update({
			state: {
				...state,
				isStreaming: true,
				pendingMessageCount: Math.max(1, state.pendingMessageCount),
				hasMessages: true,
				lastEventType: "agent_start",
			},
		});
	};
	const scheduler = createRpcPromptScheduler({
		getBusy: () => {
			const state = stateStore.getSnapshot();
			return treeNavigationBusy || state.isStreaming || state.isCompacting;
		},
		handleHostCommand: (message) => actions?.handleSubmittedText(message) ?? false,
		sendPrompt: async (message) => {
			responseData(await client.send({ type: "prompt", message }), "prompt");
		},
		onQueueChange: (messages) => {
			const state = stateStore.setHostQueuedMessages(messages);
			runtime?.update({ state });
		},
		onDispatchStart: paintDispatchStart,
		onDispatchFailure: (error) => {
			runtime?.update({ state: stateStore.getSnapshot() });
			notifications.notify(`prompt failed: ${truncateForNotification(error instanceof Error ? error.message : String(error))}`, "error");
		},
	});
	let releaseInitialHydration!: () => void;
	const initialHydration = new Promise<void>((resolve) => {
		releaseInitialHydration = resolve;
	});
	const hydrationActionGate = new InitialHydrationActionGate(initialHydration);
	/**
	 * The retained editor can accept text as soon as the splash paints, but a
	 * submit must wait for scheduler session ownership to rebind. Otherwise an
	 * Enter pressed during the initial get_state/get_messages quiet-loop could
	 * be consumed by the pre-hydration scheduler generation. Keeping this gate
	 * at submit (not typing) preserves early editing without dropping a prompt.
	 */
	const submitFromEditor = async (message: string): Promise<void> => {
		await initialHydration;
		if (treeNavigationBusy) {
			notifications.notify("branch summary in progress", "warning");
			return;
		}
		await submitRpcPrompt(message, {
			visualFixture,
			scheduler,
			client,
		});
	};
	const keybindings = createRpcKeybindingsManager({ env });
	const handleModelCycleForward = createModelCycleForwardHandler({
		controls,
		notifications,
		onStateChange: pushStateAndCacheChrome,
	});
	const handleModelCycleBackward = createModelCycleBackwardHandler({
		controls,
		notifications,
		onStateChange: pushStateAndCacheChrome,
	});
	const handleThinkingCycle = createThinkingCycleHandler({
		controls,
		notifications,
		onStateChange: pushStateAndCacheChrome,
	});
	const handleToolsExpandToggle = createToolsExpandToggleHandler({
		toggleActivityExpansion: () => runtime?.toggleActivityExpansion(),
		requestRender,
	});
	const handleMessageFollowUp = (): void => {
		handleRpcMessageFollowUp({ editor, scheduler, notifications, isBlocked: () => treeNavigationBusy });
	};
	const handleMessageDequeue = (): void => {
		handleRpcMessageDequeue({ editor, scheduler, stateStore, notifications });
	};
	const editor = new RpcHostEditorController({
		controls,
		cwd,
		env,
		keybindings,
		onRenderRequest: requestRender,
		errorNotifier: notifications,
		// app.exit (Ctrl+D by default, or the user's keybindings.json remap):
		// CustomEditor only invokes this when the editor is empty (enforced
		// inside CustomEditor itself -- see editor.ts's onExit doc comment).
		// Same clean-shutdown path as `/quit` (host-actions.ts: `onExitRequest(0)`
		// -> here, `requestHostExit(0)` -> `runtime?.stop(0)`).
		onExit: () => requestHostExit(0),
		// app.interrupt (Escape by default, or the user's remap): replay into
		// the interrupt tier module (see `handleAppInterrupt` above).
		onInterrupt: () => handleAppInterrupt(),
		onSubmit: submitFromEditor,
		// app.model.cycleForward / app.model.cycleBackward / app.thinking.cycle
		// / app.tools.expand: registered via CustomEditor's generic
		// `onAction` map (see editor.ts's onModelCycleForward etc. doc
		// comments) rather than a dedicated callback prop.
		onModelCycleForward: () => hydrationActionGate.run("model-cycle-forward", handleModelCycleForward),
		onModelCycleBackward: () => hydrationActionGate.run("model-cycle-backward", handleModelCycleBackward),
		// app.model.select (Ctrl+L by default): opens the same in-place model
		// selector `/model` with no args and the command palette's "MODEL"
		// entry both already use. `actions` is a forward reference (assigned
		// below, after `editor` -- same closure-captures-later-assignment
		// pattern `submitFromEditor` above already relies on for `actions`)
		// since `RpcHostActions` itself needs `editorText: editor` to
		// construct.
		onModelSelect: () => hydrationActionGate.run("model-select", () => {
			void notifyOnError(async () => { await actions?.openModelSelector(); }, notifications);
		}),
		onThinkingCycle: () => hydrationActionGate.run("thinking-cycle", handleThinkingCycle),
		onToolsExpandToggle: handleToolsExpandToggle,
		onMessageFollowUp: () => hydrationActionGate.run("message-follow-up", handleMessageFollowUp),
		onMessageDequeue: () => hydrationActionGate.run("message-dequeue", handleMessageDequeue),
		// app.theme.cycle (Shift+Ctrl+T / Alt+T): host-side — the child
		// extension's pi.registerShortcut never receives keys in RPC mode.
		// Same forward-reference pattern as onModelSelect above.
		onThemeCycle: () => actions?.cycleTheme(),
	});
	// In-place selector surface (plan 036): occupies the editor's Yoga slot for
	// `/model`, `/thinking`, `/sessions`, `/settings`, and `/fork` instead of
	// the old full-screen `ModalLayer` backdrop -- see inline-selector.ts's
	// doc comment. Wraps `editor` (not replaces it): `editorText`/
	// `handlePreEditorInput`/`uiResponder` below all keep pointing at the real
	// `RpcHostEditorController` directly, since none of them care which
	// component currently occupies the visual editor slot. Only the
	// `RpcHostRuntime`'s `editor` prop (the shell's rendered/input-routed
	// component) needs to see the wrapper.
	const inlineSelectors = new InlineSelectorHost(editor, requestRender);
	const uiResponder = createRpcExtensionUiResponder({
		modals,
		notifications,
		regionRegistry,
		statusPublication,
		editorText: editor,
		terminal: hostTerminal,
		treeNavigationOutcomeBroker,
		onRenderRequest: requestRender,
	});
	client.setUiRequestHandler((request) => uiResponder.handle(request));
	// After new/switch/clone/fork the child's message list changed out from
	// under the host, but nothing repaints the transcript on its own -- the
	// old session's messages otherwise stay on screen as a "ghost transcript".
	// Refetch get_messages and push the result through the same
	// replaceFromMessages/runtime.update path used for initial hydration below.
	const readTranscriptMessages = async () => responseData(
		await client.send({ type: "get_messages" }),
		"get_messages",
	).messages;
	const readTranscript = async () => transcriptPump.replaceFromMessages(await readTranscriptMessages());
	const rehydrateTranscript = async (): Promise<void> => {
		const transcript = await readTranscript();
		runtime?.update({ transcript, transcriptRevision: transcriptPump.getRevision() });
	};
	const processAgentEvent = (event: AgentSessionEvent): void => {
		const transcript = transcriptPump.handleAgentEvent(event);
		const state = stateStore.handleAgentEvent(event);
		runtime?.update({ state, transcript, transcriptRevision: transcriptPump.getRevision() });
		scheduler.handleAgentEvent(event);
	};
	let sessionHydrationRetrying = false;
	const beginSessionChange = (): void => {
		if (!sessionEvents.begin()) return;
		sessionHydrationRetrying = false;
		deferActivityRuntimeUpdate = true;
		runtime?.beginSessionReplacement();
	};
	const cancelSessionChange = (): void => {
		if (!sessionEvents.isActive) return;
		const events = sessionEvents.finish();
		sessionHydrationRetrying = false;
		deferActivityRuntimeUpdate = false;
		runtime?.update({
			state: stateStore.getSnapshot(),
			activities: activityPresentation(latestActivitySnapshot),
		});
		runtime?.endSessionReplacement();
		for (const event of events) processAgentEvent(event);
	};
	let sessionHydrationRetryTimer: ReturnType<typeof setTimeout> | undefined;
	const treeNavigationRetryScheduler = createRpcTreeNavigationRetryScheduler();
	let treeNavigationRecovery: {
		readonly outcome?: RpcTreeNavigationOutcome;
		readonly entryCount: number;
		readonly identityChanged: boolean;
		/** Release the tree guard after fail-closed hydration instead of retrying quiet settle. */
		readonly releaseAfterRecovery?: boolean;
	} | undefined;
	const refreshSessionRuntime = async (): Promise<void> => {
		if (sessionHydrationRetryTimer) clearTimeout(sessionHydrationRetryTimer);
		sessionHydrationRetryTimer = undefined;
		const continuingFailedHydration = sessionHydrationRetrying;
		beginSessionChange();
		// The mutating command has returned (or failed ambiguously). Everything
		// before this boundary is superseded by the authoritative destination
		// get_state/get_messages snapshots; only their concurrent suffix replays.
		if (!continuingFailedHydration) sessionEvents.markHydrationBaseline();
		let ownershipRebound = false;
		let hydrationSucceeded = false;
		try {
			if (!continuingFailedHydration) {
				// The child has already switched. Fail closed before any follow-up RPC so
				// a timeout cannot leave A's private transcript/feed or queued prompts
				// accepting B events. Restore A's queue to the editor and invalidate any
				// in-flight scheduler generation before the first fallible request.
				const detached = scheduler.rebindSession(undefined, editor.getText());
				if (detached.count > 0) editor.setText(detached.text);
				latestActivitySnapshot = activityStore.bindSession(undefined);
				const emptyTranscript = transcriptPump.replaceFromMessages([]);
				runtime?.update({
					transcript: emptyTranscript,
					transcriptRevision: transcriptPump.getRevision(),
					activities: activityPresentation(latestActivitySnapshot),
				});
			}

			let state: RpcHostChromeState | undefined;
			let messages: readonly unknown[] | undefined;
			for (let attempt = 0; attempt < 4; attempt += 1) {
				// If a complete hydration pass observes events, retry: a request sent
				// after those events gives us an authoritative snapshot that includes
				// them. A quiet pass establishes an exact response-order boundary.
				sessionEvents.markHydrationBarrier();
				state = await controls.refreshState();
				if (!ownershipRebound) {
					const rebound = scheduler.rebindSession(state.sessionId, editor.getText());
					if (rebound.count > 0) editor.setText(rebound.text);
					latestActivitySnapshot = activityStore.bindSession(state.sessionId);
					runtime?.update({ state, activities: activityPresentation(latestActivitySnapshot) });
					ownershipRebound = true;
				}
				messages = await readTranscriptMessages();
				if (!sessionEvents.hasEventsAfterHydrationBarrier) {
					sessionEvents.markHydrationBarrier();
					break;
				}
			}
			if (!state || !messages) throw new Error("Session hydration did not produce a snapshot");
			const transcript = transcriptPump.replaceFromMessages(messages);
			hydrationSucceeded = true;
			runtime?.update({
				state,
				transcript,
				transcriptRevision: transcriptPump.getRevision(),
				activities: activityPresentation(latestActivitySnapshot),
			});
			// Session replacement can change the authoritative model/thinking
			// without going through a model action callback. Refresh the startup
			// hint only after both destination state and transcript commit.
			cacheChromeState(state);
		} catch {
			// Keep the event buffer and fail-closed replacement active until both
			// authoritative destination state and message history are fetched.
			// Retrying here preserves the suffix without risking cross-session
			// disclosure or committing an incomplete transcript.
		} finally {
			if (!hydrationSucceeded) {
				sessionHydrationRetrying = true;
				sessionHydrationRetryTimer = setTimeout(() => {
					sessionHydrationRetryTimer = undefined;
					void refreshSessionRuntime();
				}, 100);
				sessionHydrationRetryTimer.unref?.();
				return;
			}
			sessionHydrationRetrying = false;
			const replay = sessionEvents.finishHydration();
			// State/messages snapshots supersede UI projection for earlier passes,
			// but event-only scheduler effects still replay in order. The final
			// in-flight suffix goes through every consumer and identity reconciliation.
			for (const event of replay.supersededSnapshotEvents) scheduler.handleAgentEvent(event);
			for (const event of replay.suffixEvents) processAgentEvent(event);
			deferActivityRuntimeUpdate = false;
			runtime?.endSessionReplacement(ownershipRebound);
			const recovery = treeNavigationRecovery;
			if (recovery) {
				treeNavigationRecovery = undefined;
				queueMicrotask(() => {
					if (!treeNavigationCapture) return;
					if (recovery.identityChanged || recovery.releaseAfterRecovery) {
						finishTreeNavigation(recovery.outcome, false, recovery.entryCount);
					} else {
						void reconcileTreeNavigation(recovery.outcome).catch(() => undefined);
					}
				});
			}
		}
	};

	const setTreeNavigationBusy = (busy: boolean): void => {
		// A failed/ambiguous reconcile keeps the guard. The action's finally block
		// may still ask to clear it, but only the lifecycle below can release it.
		if (!busy && treeNavigationCapture) return;
		treeNavigationBusy = busy;
		const state = stateStore.setBranchSummaryBusy(busy);
		runtime?.update({ state, ...(busy ? {} : { activities: activityPresentation(latestActivitySnapshot) }) });
		if (!busy) deferActivityRuntimeUpdate = false;
	};

	const beforeTreeNavigation = async (request: RpcTreeNavigationRequest): Promise<void> => {
		if (treeNavigationCapture) throw new Error("tree navigation is already active");
		const state = stateStore.getSnapshot();
		const editorBefore = editor.getText();
		const schedulerBefore = scheduler.getSnapshot();
		const wasStreaming = state.isStreaming || schedulerBefore.dispatching === true;
		if (!sessionEvents.begin()) throw new Error("session event barrier is already active");
		deferActivityRuntimeUpdate = true;
		// This is deliberately synchronous before the abort request: queued host
		// drafts belong to the current session and must not be lost or dispatched
		// into a newly selected branch.
		const restored = scheduler.restoreAll(editorBefore, { discardInFlight: true });
		if (restored.count > 0) editor.setText(restored.text);
		try {
			let snapshot = await readAuthoritativeSessionSnapshot(controls, {
				sessionFile: state.sessionFile,
				sessionId: state.sessionId,
			});
			let messages = await readTranscriptMessages();
			const pagerState = transcriptPump.getLiveStateSnapshot();
			const pagerRevision = transcriptPump.getRevision();
			logDiagnostic("tree.navigation_started", {
				elapsedMs: 0,
				entryCount: snapshot.entries.length,
				summaryMode: treeSummaryMode(request),
				pagerRevision,
				pagerHadDraft: pagerState.draftMessage ?? false,
				draftWasNonEmpty: editorBefore.length !== 0,
			});
			if (wasStreaming) {
				await controls.abort();
				// Abort may settle the active turn on a different leaf before Pi
				// accepts the navigation command. Rebaseline cancellation against the
				// post-abort authoritative leaf/messages, not the pre-abort snapshot.
				snapshot = await readAuthoritativeSessionSnapshot(controls, {
					sessionFile: state.sessionFile,
					sessionId: state.sessionId,
				});
				messages = await readTranscriptMessages();
			}
			treeNavigationCapture = {
				request,
				sessionId: state.sessionId,
				sessionFile: state.sessionFile,
				leafId: snapshot.leafId,
				editorText: editorBefore,
				messages,
				pagerState,
				pagerRevision,
				startedAt: Date.now(),
			};
		} catch (error) {
			const events = sessionEvents.finish();
			deferActivityRuntimeUpdate = false;
			for (const event of events) processAgentEvent(event);
			throw error;
		}
	};

	const scheduleTreeNavigationRetry = (outcome: RpcTreeNavigationOutcome | undefined): void => {
		if (!treeNavigationCapture) return;
		treeNavigationRetryScheduler.schedule(() => reconcileTreeNavigation(outcome));
	};

	const finishTreeNavigation = (outcome: RpcTreeNavigationOutcome | undefined, success: boolean, entryCount: number): void => {
		const capture = treeNavigationCapture;
		const elapsedMs = capture ? Math.max(0, Date.now() - capture.startedAt) : 0;
		logDiagnostic("tree.navigation_finished", {
			elapsedMs,
			entryCount,
			summaryMode: capture ? treeSummaryMode(capture.request) : "none",
			outcomeStatus: outcome?.status ?? "unknown",
			success,
			pagerRevision: capture?.pagerRevision ?? null,
			pagerHadDraft: capture?.pagerState.draftMessage ?? false,
		});
		treeNavigationCapture = undefined;
		treeNavigationRecovery = undefined;
		treeNavigationRetryScheduler.clear();
		setTreeNavigationBusy(false);
	};

	const reconcileTreeNavigation = async (outcome?: RpcTreeNavigationOutcome): Promise<void> => {
		const capture = treeNavigationCapture;
		if (!capture) return;
		let state: RpcHostChromeState | undefined;
		let messages: readonly unknown[] | undefined;
		let authoritativeLeaf: string | null | undefined;
		let entryCount = 0;
		let identityChanged = false;
		let hydrated = false;
		try {
			const hydration = await hydrateSameSessionTreeNavigation({
				waitForQuiet: () => waitForTreeNavigationQuiet(() => controls.refreshState(), options.treeNavigationQuietTiming),
				markHydrationBaseline: () => sessionEvents.markHydrationBaseline(),
				markHydrationBarrier: () => sessionEvents.markHydrationBarrier(),
				hasEventsAfterHydrationBarrier: () => sessionEvents.hasEventsAfterHydrationBarrier,
				refreshState: () => controls.refreshState(),
				readMessages: readTranscriptMessages,
				readSnapshot: () => readAuthoritativeSessionSnapshot(controls, {
					sessionFile: capture.sessionFile,
					sessionId: capture.sessionId,
				}),
				sessionId: capture.sessionId,
				sessionFile: capture.sessionFile,
			});
			state = hydration.state;
			identityChanged = hydration.identityChanged;
			if (!identityChanged) {
				messages = hydration.messages;
				authoritativeLeaf = hydration.snapshot?.leafId;
				entryCount = hydration.snapshot?.entries.length ?? 0;
			}
			if (identityChanged) {
				// A same-session operation unexpectedly changed ownership. Reuse the
				// established fail-closed replacement hydration rather than exposing A
				// with B's transcript or scheduler state. If that hydration is transiently
				// unavailable, its retry completion releases the tree guard below.
				treeNavigationRecovery = { outcome, entryCount, identityChanged: true };
				await refreshSessionRuntime();
				if (sessionHydrationRetrying) throw new Error("replacement hydration is still pending");
				finishTreeNavigation(outcome, false, entryCount);
				return;
			}
			if (!state || !messages || authoritativeLeaf === undefined) throw new Error("tree navigation hydration did not produce a snapshot");
			const messagesChanged = !valuesEqual(capture.messages, messages);
			const shouldReplaceTranscript = outcome?.status === "committed" || messagesChanged;
			const transcript = shouldReplaceTranscript
				? transcriptPump.replaceFromMessages(messages)
				: transcriptPump.viewModel();
			const leafMatches = outcome?.status !== "committed" || outcome.leafId === authoritativeLeaf;
			const cancelledLeafPreserved = outcome?.status !== "cancelled" || authoritativeLeaf === capture.leafId;
			const hydrationSuccess = leafMatches && cancelledLeafPreserved;
			logDiagnostic("tree.rehydrate_finished", {
				elapsedMs: Math.max(0, Date.now() - capture.startedAt),
				entryCount,
				summaryMode: treeSummaryMode(capture.request),
				outcomeStatus: outcome?.status ?? "unknown",
				success: hydrationSuccess,
			});
			runtime?.update({ state, transcript, transcriptRevision: transcriptPump.getRevision() });
			const replay = sessionEvents.finishHydration();
			for (const event of replay.supersededSnapshotEvents) scheduler.handleAgentEvent(event);
			for (const event of replay.suffixEvents) processAgentEvent(event);
			if (outcome?.status === "committed" && outcome.editorText !== undefined && editor.getText().length === 0) {
				editor.setText(outcome.editorText);
			}
			finishTreeNavigation(outcome, outcome?.status === "committed" && hydrationSuccess, entryCount);
			hydrated = true;
			if (!hydrationSuccess) throw new Error("tree navigation outcome did not match authoritative session state");
		} catch (error) {
			if (hydrated) throw error;
			// Once get_state has confirmed the captured identity, a transient
			// get_messages/get_entries failure is retried in place. Do not rebind
			// the scheduler or enter replacement mode for a same-session retry.
			if (state !== undefined && !identityChanged) {
				scheduleTreeNavigationRetry(outcome);
				throw error;
			}
			// An unknown or changed identity still uses the established fail-closed
			// replacement seam. If it schedules a retry, the successful replacement
			// pass consumes treeNavigationRecovery and clears the guard. A bounded
			// compaction settle expiry must not re-enter the same wait forever: once
			// fail-closed hydration succeeds, release the host guard without inventing
			// a branch outcome or weakening the identity checks above.
			const settleExpired = error instanceof RpcTreeNavigationQuietTimeoutError;
			treeNavigationRecovery = { outcome, entryCount, identityChanged, releaseAfterRecovery: settleExpired };
			try {
				await refreshSessionRuntime();
			} catch {
				throw error;
			}
			if (sessionHydrationRetrying) throw error;
			finishTreeNavigation(outcome, false, entryCount);
			throw error;
		}
	};

	const replayCancelledSessionEvents = async (): Promise<void> => {
		cancelSessionChange();
	};
	actions = new RpcHostActions({
		controls,
		stateStore,
		modals,
		overlays,
		inlineSelectors,
		notifications,
		editorText: editor,
		onStateChange: pushStateAndCacheChrome,
		onRenderRequest: requestRender,
		onExitRequest: (code) => requestHostExit(code),
		rehydrateTranscript,
		beforeSessionChange: beginSessionChange,
		cancelSessionChange,
		afterSessionChange: refreshSessionRuntime,
		afterCancelledSessionChange: replayCancelledSessionEvents,
		beforeTreeNavigation,
		reconcileTreeNavigation,
		setTreeNavigationBusy,
		isTreeNavigationBusy: () => treeNavigationBusy,
		writeClipboardSequence: (sequence) => runtime?.writeClipboardSequence(sequence) ?? false,
		changelogRoot: root,
	});
	const hydrationGatedInputHandler = {
		openCommandPalette: (): void => hydrationActionGate.run("command-palette", () => {
			void notifyOnError(() => actions!.openCommandPalette(), notifications);
		}),
	};
	let statsTimer: NodeJS.Timeout | undefined;
	let statsInFlight = false;
	let stopWatchingGitBranch: (() => void) | undefined;
	let stopPromise: Promise<void> | undefined;
	let requestedHostExitCode: number | undefined;

	client.onEvent((event) => {
		if (visualFixture) return;
		if (sessionEvents.capture(event)) return;
		processAgentEvent(event);
	});

	// The RPC child is the whole agent -- without this, the host has no signal
	// at all when it dies while idle (no pending request to reject) and keeps
	// rendering against a corpse forever; see createRpcExitHandler for why each
	// step (close modals/overlays, clear streaming state, notify, exit
	// nonzero) is needed.
	const handleClientExit = createRpcExitHandler({
		modals,
		overlays,
		selector: inlineSelectors,
		stateStore,
		notifications,
		requestRender,
		stopHost: (code) => stopHost(code),
		exit: exitProcess,
		updateRuntimeState: (state) => runtime?.update({ state }),
	});
	client.onExit((error) => {
		if (visualFixture) return;
		handleClientExit(error);
	});

	const refreshStats = async (): Promise<void> => {
		if (statsInFlight) return;
		statsInFlight = true;
		try {
			const statsResponse = await client.send({ type: "get_session_stats" }, 5_000);
			const stats = responseData(statsResponse, "get_session_stats");
			const state = stateStore.hydrateFromSessionStats(stats);
			runtime?.update({ state });
		} catch {
			// Stats are useful chrome data, but an empty/offline shell must still boot.
		} finally {
			statsInFlight = false;
		}
	};

	const stop = async (code = 0): Promise<void> => {
		stopPromise ??= (async () => {
			if (statsTimer) clearInterval(statsTimer);
			if (sessionHydrationRetryTimer) clearTimeout(sessionHydrationRetryTimer);
			sessionHydrationRetryTimer = undefined;
			treeNavigationRetryScheduler.clear();
			treeNavigationRecovery = undefined;
			stopWatchingGitBranch?.();
			stopWatchingGitBranch = undefined;
			runtime?.stop(code);
			if (!regionRegistryDisposed) {
				regionRegistryDisposed = true;
				regionRegistry.dispose();
			}
			unsubscribeActivityStore();
			activityStore.dispose();
			await client.stop();
		})();
		await stopPromise;
	};
	stopHost = stop;
	requestHostExit = (code: number): void => {
		requestedHostExitCode = code;
		runtime?.stop(code);
		// Do not wait for initial hydration to finish before tearing down the RPC
		// child. Stopping it rejects any pending startup request, which transfers
		// control to the catch/finally path immediately; stop() is idempotent.
		void stopHost(code);
	};
	const handlePreEditorInput = createRpcHostInterruptHandler({
		modals,
		overlays,
		selector: inlineSelectors,
		editor,
		stateStore,
		controls,
		notifications,
		requestHostExit: (code) => requestHostExit(code),
		submitInFlight: () => scheduler.getSnapshot().busy || actions?.isLoginActive() === true,
		isTreeNavigationBusy: () => treeNavigationBusy,
		abortInFlight: async () => {
			if (actions?.isLoginActive()) await actions.cancelLogin();
			else await controls.abort();
		},
		restoreQueuedDrafts: () => {
			const restored = scheduler.restoreAll(editor.getText(), { discardInFlight: true });
			if (restored.count > 0) editor.setText(restored.text);
		},
	});
	// A canonical escape token replays the exact same classification
	// (dismiss-modal / abort / arm-quit / quit / pass) `handlePreEditorInput`
	// already applies to a real Ctrl-C/Escape keypress -- see the
	// `handleAppInterrupt` declaration above for why this is the correct reuse
	// point instead of a second, editor-local interrupt implementation.
	handleAppInterrupt = (): void => { handlePreEditorInput("\x1b"); };
	const handleSigint = (): void => { void stop(130).then(() => exitProcess(130)); };
	const handleSigterm = (): void => { void stop(0).then(() => exitProcess(0)); };
	process.once("SIGINT", handleSigint);
	process.once("SIGTERM", handleSigterm);

	try {
		// Initial boot has the same response/event ordering race as a session
		// switch: an event parsed immediately after get_messages resolves can land
		// before the awaiting continuation replaces the transcript. Buffer before
		// child startup, refetch until one quiet pass, then replay only the final
		// suffix after the authoritative replacement.
		if (!visualFixture) sessionEvents.begin();
		await client.start();
		options.onPreSpawnedChildAdopted?.();
		const branch = await readGitBranch(cwd);
		const cachedChrome = visualFixture ? undefined : readCachedChrome(cwd);
		if (cachedChrome) stateStore.seedChrome(cachedChrome);
		const initialTranscript = visualFixture ? visualFixture.transcript : transcriptPump.viewModel();
		const initialState = visualFixture ? visualFixture.state : stateStore.setGitBranch(branch);
		const initialRuntime = new RpcHostRuntime({
			output: stdout,
			input: stdin,
			env,
			initialState,
			initialTranscript,
			initialActivities: activityPresentation(latestActivitySnapshot),
			onActivityExpansionChange: (id, expanded) => activityStore.setExpanded(id, expanded),
			onActivityExpansionMigration: (previousId, nextId, expanded) => activityStore.migrateExpanded(previousId, nextId, expanded),
			onAllActivityExpansionChange: (expanded, ids) => activityStore.setAllExpanded(expanded, ids),
			inputPreview: visualFixture?.inputPreview,
			// The wrapper, not the bare controller: while an inline selector
			// (plan 036) is open it renders/handles-input in the editor's
			// place, then hands the slot back to `editor` on close -- see
			// `InlineSelectorHost`'s doc comment.
			editor: inlineSelectors,
			modal: modals,
			overlay: overlays,
			notifications,
			extensionRegions: {
				aboveEditor: regionRegistry.createStackPublication(["status", "widgets-default", "aboveEditor"]).component,
				belowEditor: regionRegistry.createStackPublication(["belowEditor"], { filterBlankRows: true }).component,
				sidebar: regionRegistry.createSlotPublication("sidebar").component,
			},
			inputHandler: hydrationGatedInputHandler,
			preEditorInputHandler: handlePreEditorInput,
		});
		runtime = initialRuntime;
		await initialRuntime.start();
		// The store may bind and publish an on-disk feed snapshot while the
		// authoritative state/messages quiet-loop is still running. Hold that
		// intermediate repaint so the single post-hydration update can apply cold
		// feed suppression and transcript ownership atomically.
		deferActivityRuntimeUpdate = true;

		if (visualFixture) {
			const refreshedState = await controls.refreshState(branch);
			const restored = scheduler.rebindSession(refreshedState.sessionId, editor.getText());
			if (restored.count > 0) editor.setText(restored.text);
			latestActivitySnapshot = activityStore.bindSession(refreshedState.sessionId);
			releaseInitialHydration();
		} else {
			let refreshedState: RpcHostChromeState | undefined;
			let messages: readonly unknown[] | undefined;
			let ownershipRebound = false;
			for (let attempt = 0; attempt < 4; attempt += 1) {
				sessionEvents.markHydrationBarrier();
				refreshedState = await controls.refreshState(branch);
				if (!ownershipRebound) {
					const restored = scheduler.rebindSession(refreshedState.sessionId, editor.getText());
					if (restored.count > 0) editor.setText(restored.text);
					latestActivitySnapshot = activityStore.bindSession(refreshedState.sessionId);
					ownershipRebound = true;
				}
				messages = await readTranscriptMessages();
				if (!sessionEvents.hasEventsAfterHydrationBarrier) {
					sessionEvents.markHydrationBarrier();
					break;
				}
			}
			if (!refreshedState || !messages) throw new Error("Initial session hydration did not produce a snapshot");
			transcriptPump.replaceFromMessages(messages);
			const replay = sessionEvents.finishHydration();
			for (const event of replay.supersededSnapshotEvents) scheduler.handleAgentEvent(event);
			for (const event of replay.suffixEvents) processAgentEvent(event);
			releaseInitialHydration();
			stopWatchingGitBranch = await watchGitBranch(cwd, branch, (nextBranch) => {
				const state = stateStore.setGitBranch(nextBranch);
				runtime?.update({ state });
			});
			const hydratedState = stateStore.getSnapshot();
			initialRuntime.update({
				state: hydratedState,
				transcript: transcriptPump.viewModel(),
				activities: activityPresentation(latestActivitySnapshot),
				suppressSettledFeedOnly: true,
			});
			cacheChromeState(hydratedState);
		}
		deferActivityRuntimeUpdate = false;
		await editor.configureAutocomplete(controls);
		initialRuntime.markChromeStable();
		if (!visualFixture) {
			// Submit the launcher's kickoff prompt (if any) only after start() +
			// initial hydration above, so the transcript/UI are already in a
			// normal steady state when the submit's streaming-state painting and
			// event handling kick in -- see submitInitialPromptFromEnv's doc
			// comment for why this reuses submitFromEditor instead of a bespoke
			// path.
			await submitInitialPromptFromEnv(env, submitFromEditor);
			await refreshStats();
			statsTimer = setInterval(() => { void refreshStats(); }, 5_000);
		}
		return await initialRuntime.waitForExit();
	} catch (error) {
		await stop(requestedHostExitCode ?? 0);
		if (requestedHostExitCode !== undefined) return requestedHostExitCode;
		writeLine(stderr, `[sumocode-rpc] ${error instanceof Error ? error.message : String(error)}`);
		if (client.stderr.length > 0) writeLine(stderr, client.stderr.trim());
		return 1;
	} finally {
		process.removeListener("SIGINT", handleSigint);
		process.removeListener("SIGTERM", handleSigterm);
		process.removeListener("unhandledRejection", handleUnhandledRejection);
		process.removeListener("uncaughtException", handleUnhandledRejection);
		await stop();
	}
}

export async function main(options: RpcHostMainOptions = {}): Promise<void> {
	const code = await runRpcHost(options);
	// Covers every runRpcHost path that returns a code naturally instead of
	// calling process.exit directly (the plain `runtime.waitForExit()` return
	// and the top-level catch's `return 1`) -- the explicit process.exit call
	// sites inside runRpcHost (SIGINT/SIGTERM, unhandledRejection/
	// uncaughtException, createRpcExitHandler's reload/crash paths) already
	// write via exitProcess before this point is ever reached.
	writeExitCodeFile(process.env, code);
	process.exitCode = code;
}
