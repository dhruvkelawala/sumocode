import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { SUMOCODE_RELOAD_EXIT_CODE } from "../../commands/reload.js";
import { containsCtrlCToken, isEscapeInput } from "../input/shared-input-router.js";
import { loadYoga } from "../layout/yoga.js";
import { applyStartupTheme } from "../../themes/index.js";
import { ExtensionStatusPublication, RegionRegistry } from "../pi-compat/region-registry.js";
import type { TranscriptControllerChatSink } from "../transcript/controller.js";
import type { ChatMessageViewModel } from "../transcript/view-model.js";
import type { ChatPagerReplaceStats } from "../widgets/chat-pager.js";
import { ModalLayer } from "../widgets/modal-layer.js";
import { NotificationCenter } from "../widgets/notification.js";
import { RpcChildExitError, SumoRpcClient, truncateForNotification } from "./client.js";
import { RpcHostControls } from "./controls.js";
import { createRpcKeybindingsManager, RpcHostEditorController } from "./editor.js";
import { createRpcExtensionUiResponder } from "./extension-ui-responder.js";
import { RpcHostActions } from "./host-actions.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { InlineSelectorHost } from "./inline-selector.js";
import { decideRpcInterrupt, type RpcInterruptInputKind } from "./interrupt.js";
import { readGitBranch, watchGitBranch } from "./git.js";
import { createRpcPromptScheduler, type RpcPromptScheduler } from "./prompt-scheduler.js";
import { RpcHostRuntime } from "./runtime.js";
import { responseData } from "./response.js";
import { notifyOnError, type ErrorNotifier } from "./safe-send.js";
import { RpcHostStateStore, type RpcHostChromeState } from "./state.js";
import { RpcTranscriptPump } from "./transcript-pump.js";
import { rpcVisualFixtureFromEnv } from "./visual-fixtures.js";

export interface RpcHostMainOptions {
	readonly argv?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly stdout?: NodeJS.WriteStream;
	readonly stdin?: NodeJS.ReadStream;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
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

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = {
		...env,
		SUMOCODE_RPC_CHILD: "1",
		SUMO_TUI: "0",
	};
	return next;
}

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
		replaceViewModels: (messages) => getRuntime()?.getChatSink()?.replaceViewModels(messages) ?? fallbackChatSinkStats(messages),
		addViewModel: (message) => getRuntime()?.getChatSink()?.addViewModel(message),
		replaceLastWithViewModel: (message) => getRuntime()?.getChatSink()?.replaceLastWithViewModel(message),
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
}

export function handleRpcMessageFollowUp(deps: RpcMessageFollowUpDependencies): void {
	void notifyOnError(async () => {
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
	readonly notifications: Pick<NotificationCenter, "notify">;
	readonly requestHostExit: (code: number) => void;
	/**
	 * True in the window between a prompt submission and the RPC child's
	 * `agent_start` event, when `stateStore`'s `isStreaming` bit has not yet
	 * flipped. Without this, a Ctrl-C sent in that window is treated as the
	 * pre-streaming arm-quit tier instead of an abort.
	 */
	readonly submitInFlight?: () => boolean;
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
					await deps.controls.abort();
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
	const extensionPath = resolve(root, "src/extension.ts");
	const client = new SumoRpcClient({
		command: piBinary(env),
		args: ["--mode", "rpc", "-e", extensionPath, ...argv],
		cwd,
		env: childEnv(env),
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
	const requestRender = (): void => runtime?.requestRender();
	const pushState = (state?: RpcHostChromeState): void => {
		runtime?.update({ state: state ?? stateStore.getSnapshot() });
	};
	const controls = new RpcHostControls(client, stateStore, { onOptimisticChange: pushState });
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
			return state.isStreaming || state.isCompacting;
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
	const submitFromEditor = async (message: string): Promise<void> => {
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
		onStateChange: pushState,
	});
	const handleModelCycleBackward = createModelCycleBackwardHandler({
		controls,
		notifications,
		onStateChange: pushState,
	});
	const handleThinkingCycle = createThinkingCycleHandler({
		controls,
		notifications,
		onStateChange: pushState,
	});
	const handleToolsExpandToggle = createToolsExpandToggleHandler({
		toggleActivityExpansion: () => runtime?.toggleActivityExpansion(),
		requestRender,
	});
	const handleMessageFollowUp = (): void => {
		handleRpcMessageFollowUp({ editor, scheduler, notifications });
	};
	const handleMessageDequeue = (): void => {
		handleRpcMessageDequeue({ editor, scheduler, stateStore, notifications });
	};
	const editor = new RpcHostEditorController({
		controls,
		cwd,
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
		onModelCycleForward: handleModelCycleForward,
		onModelCycleBackward: handleModelCycleBackward,
		// app.model.select (Ctrl+L by default): opens the same in-place model
		// selector `/model` with no args and the command palette's "MODEL"
		// entry both already use. `actions` is a forward reference (assigned
		// below, after `editor` -- same closure-captures-later-assignment
		// pattern `submitFromEditor` above already relies on for `actions`)
		// since `RpcHostActions` itself needs `editorText: editor` to
		// construct.
		onModelSelect: () => { void notifyOnError(async () => { await actions?.openModelSelector(); }, notifications); },
		onThinkingCycle: handleThinkingCycle,
		onToolsExpandToggle: handleToolsExpandToggle,
		onMessageFollowUp: handleMessageFollowUp,
		onMessageDequeue: handleMessageDequeue,
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
		onRenderRequest: requestRender,
	});
	client.setUiRequestHandler((request) => uiResponder.handle(request));
	// After new/switch/clone/fork the child's message list changed out from
	// under the host, but nothing repaints the transcript on its own -- the
	// old session's messages otherwise stay on screen as a "ghost transcript".
	// Refetch get_messages and push the result through the same
	// replaceFromMessages/runtime.update path used for initial hydration below.
	const rehydrateTranscript = async (): Promise<void> => {
		const messages = responseData(await client.send({ type: "get_messages" }), "get_messages").messages;
		const transcript = transcriptPump.replaceFromMessages(messages);
		runtime?.update({ transcript, transcriptRevision: transcriptPump.getRevision() });
	};
	actions = new RpcHostActions({
		controls,
		stateStore,
		modals,
		overlays,
		inlineSelectors,
		notifications,
		editorText: editor,
		onStateChange: pushState,
		onRenderRequest: requestRender,
		onExitRequest: (code) => requestHostExit(code),
		rehydrateTranscript,
		afterSessionChange: async () => {
			const state = await controls.refreshState();
			const restored = scheduler.rebindSession(state.sessionId, editor.getText());
			if (restored.count > 0) editor.setText(restored.text);
			await rehydrateTranscript();
		},
		writeClipboardSequence: (sequence) => runtime?.writeClipboardSequence(sequence) ?? false,
		changelogRoot: root,
	});
	let statsTimer: NodeJS.Timeout | undefined;
	let statsInFlight = false;
	let stopWatchingGitBranch: (() => void) | undefined;
	let stopPromise: Promise<void> | undefined;

	client.onEvent((event) => {
		if (visualFixture) return;
		const transcript = transcriptPump.handleAgentEvent(event);
		const state = stateStore.handleAgentEvent(event);
		runtime?.update({ state, transcript, transcriptRevision: transcriptPump.getRevision() });
		scheduler.handleAgentEvent(event);
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
			stopWatchingGitBranch?.();
			stopWatchingGitBranch = undefined;
			runtime?.stop(code);
			if (!regionRegistryDisposed) {
				regionRegistryDisposed = true;
				regionRegistry.dispose();
			}
			await client.stop();
		})();
		await stopPromise;
	};
	stopHost = stop;
	requestHostExit = (code: number): void => {
		runtime?.stop(code);
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
		submitInFlight: () => scheduler.getSnapshot().busy,
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
		await client.start();
		const branch = await readGitBranch(cwd);
		await controls.refreshState(branch);
		if (!visualFixture) {
			stopWatchingGitBranch = await watchGitBranch(cwd, branch, (nextBranch) => {
				const state = stateStore.setGitBranch(nextBranch);
				runtime?.update({ state });
			});
		}
		await editor.configureAutocomplete(controls);
		const transcript = visualFixture
			? visualFixture.transcript
			: transcriptPump.replaceFromMessages(responseData(await client.send({ type: "get_messages" }), "get_messages").messages);
		const state = visualFixture ? visualFixture.state : stateStore.getSnapshot();
		runtime = new RpcHostRuntime({
			output: stdout,
			input: stdin,
			env,
			initialState: state,
			initialTranscript: transcript,
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
			inputHandler: actions,
			preEditorInputHandler: handlePreEditorInput,
		});
		await runtime.start();
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
		return await runtime.waitForExit();
	} catch (error) {
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

export async function main(): Promise<void> {
	const code = await runRpcHost();
	// Covers every runRpcHost path that returns a code naturally instead of
	// calling process.exit directly (the plain `runtime.waitForExit()` return
	// and the top-level catch's `return 1`) -- the explicit process.exit call
	// sites inside runRpcHost (SIGINT/SIGTERM, unhandledRejection/
	// uncaughtException, createRpcExitHandler's reload/crash paths) already
	// write via exitProcess before this point is ever reached.
	writeExitCodeFile(process.env, code);
	process.exitCode = code;
}
