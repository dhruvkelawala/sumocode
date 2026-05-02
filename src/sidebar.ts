import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
	getGitBranch as getCachedGitBranch,
	getSessionUsage as getCachedSessionUsage,
	sessionHasMessages as cachedSessionHasMessages,
} from "./session-cache.js";
import { createRemnicMemoryClient, type RemnicMemoryClient } from "./memory.js";
import { MetricsHud } from "./sumo-tui/cathedral/metrics-hud.js";
import { CancellableWorkerRuntime } from "./sumo-tui/runtime/worker-runtime.js";
import {
	SIDEBAR_SUB_TABS,
	renderRegistrySidebarLines,
	type McpServerSnapshot,
	type RegistrySidebarSnapshot,
	type SidebarSessionSnapshot,
	type SidebarSubTab,
} from "./sumo-tui/cathedral/sidebar-rendering.js";
import { surfaceLine } from "./sumo-tui/cathedral/ansi.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { installNonCapturingSidebarOverlay, SIDEBAR_MIN_TERMINAL_WIDTH, sidebarOverlayTargetRows } from "./sidebar-placement.js";
import { getActiveSumoRuntime } from "./sumo-tui/pi-compat/sumo-interactive-mode.js";
export {
	SIDEBAR_MIN_TERMINAL_WIDTH,
	SIDEBAR_WIDTH,
	StaticSidebarDock,
	chooseSidebarAnchor,
	dockStaticSidebar,
	type SidebarAnchor,
} from "./sidebar-placement.js";

/** Debounce used when refreshing memories from user prompt changes. */
export const SIDEBAR_MEMORY_DEBOUNCE_MS = 200;
/** Retry cadence while Remnic is unavailable. */
export const SIDEBAR_MEMORY_RETRY_MS = 5_000;
/** Static placeholder until Pi exposes MCP server health. */
export const PLACEHOLDER_MCP: readonly McpServerSnapshot[] = [
	{ name: "github", status: "idle" },
	{ name: "stitch", status: "ok" },
	{ name: "context7", status: "idle" },
	{ name: "chrome-dev", status: "idle" },
];

export { SIDEBAR_SUB_TABS };
export type { McpServerSnapshot, SidebarSessionSnapshot, SidebarSubTab };

export type SidebarSnapshot = RegistrySidebarSnapshot;

export function renderSidebar(snapshot: SidebarSnapshot, width: number): string[] {
	return renderRegistrySidebarLines(snapshot, width).map((line) => surfaceLine(line, width));
}

export type SidebarMemoryCache = {
	/** Refreshes Remnic facts and returns true when the rendered memory snapshot changed. */
	refresh(prompt: string): Promise<boolean>;
	schedule(prompt: string, onChange: () => void): void;
	snapshot(): Pick<SidebarSnapshot, "memory" | "memoryUnavailable">;
};

const MEMORY_DISPLAY_LIMIT = 5;
const SIDEBAR_MEMORY_WORKER_GROUP = "sidebar-memory";

export function createSidebarMemoryCache(
	memoryClient: Pick<RemnicMemoryClient, "query">,
	debounceMs = SIDEBAR_MEMORY_DEBOUNCE_MS,
	workerRuntime = new CancellableWorkerRuntime(),
): SidebarMemoryCache {
	let memory: readonly string[] = [];
	let memoryUnavailable = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	function setSnapshot(nextMemory: readonly string[], nextUnavailable: boolean): boolean {
		const changed = memoryUnavailable !== nextUnavailable || memory.length !== nextMemory.length || memory.some((item, index) => item !== nextMemory[index]);
		memory = nextMemory;
		memoryUnavailable = nextUnavailable;
		return changed;
	}

	async function refresh(prompt: string): Promise<boolean> {
		const handle = workerRuntime.start({
			name: "sidebar-memory.refresh",
			exclusiveGroup: SIDEBAR_MEMORY_WORKER_GROUP,
			run: async ({ signal }) => {
				try {
					const facts = await memoryClient.query(prompt, MEMORY_DISPLAY_LIMIT);
					if (signal.aborted) return false;
					return setSnapshot(facts.map((fact) => fact.text), false);
				} catch {
					if (signal.aborted) return false;
					return setSnapshot([], true);
				}
			},
		});
		const result = await handle.result;
		return result.status === "completed" ? result.value : false;
	}

	function clearRetry(): void {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
	}

	function scheduleRetry(prompt: string, onChange: () => void): void {
		if (prompt.trim().length === 0) return;
		clearRetry();
		retryTimer = setTimeout(() => {
			void refresh(prompt).then((changed) => {
				if (changed) onChange();
				if (memoryUnavailable) scheduleRetry(prompt, onChange);
			});
		}, SIDEBAR_MEMORY_RETRY_MS);
		retryTimer.unref?.();
	}

	return {
		refresh,
		schedule(prompt: string, onChange: () => void): void {
			if (timer) clearTimeout(timer);
			clearRetry();
			workerRuntime.cancelGroup(SIDEBAR_MEMORY_WORKER_GROUP);
			const normalizedPrompt = prompt.trim();
			if (normalizedPrompt.length === 0) return;
			timer = setTimeout(() => {
				void refresh(normalizedPrompt).then((changed) => {
					if (changed) onChange();
					if (memoryUnavailable) scheduleRetry(normalizedPrompt, onChange);
				});
			}, debounceMs);
			timer.unref?.();
		},
		snapshot(): Pick<SidebarSnapshot, "memory" | "memoryUnavailable"> {
			return { memory, memoryUnavailable };
		},
	};
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const maybe = message as { role?: unknown; content?: unknown };
	if (maybe.role !== "user") return "";
	if (typeof maybe.content === "string") return maybe.content;
	if (Array.isArray(maybe.content)) {
		return maybe.content
			.map((part) => {
				if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
					return (part as { text?: unknown }).text;
				}
				return undefined;
			})
			.filter((part): part is string => typeof part === "string")
			.join("\n");
	}
	return "";
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	return cachedSessionHasMessages(ctx);
}

function snapshotFromContext(
	ctx: ExtensionContext,
	memorySnapshot: Pick<SidebarSnapshot, "memory" | "memoryUnavailable">,
	activeSubTab: SidebarSubTab,
	metrics: SidebarSnapshot["metrics"],
): SidebarSnapshot {
	const { input, output, cost } = getCachedSessionUsage(ctx);

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	// Current context tokens from Pi's live context usage API — same source as the footer.
	// Falls back to cumulative input+output only if the API is unavailable.
	const currentContextTokens = typeof contextUsage?.tokens === "number" ? contextUsage.tokens : undefined;
	const branch = getCachedGitBranch(ctx) ?? undefined;

	return {
		projectName: basename(ctx.cwd) || ctx.cwd,
		branch,
		inputTokens: input,
		outputTokens: output,
		currentContextTokens,
		contextWindow,
		cumulativeTokens: input + output,
		costUsd: cost,
		mcpServers: PLACEHOLDER_MCP,
		memory: memorySnapshot.memory,
		memoryTotal: memorySnapshot.memory.length,
		memoryUnavailable: memorySnapshot.memoryUnavailable,
		activeSubTab,
		metrics,
	};
}

/**
 * Pi-wiring glue. Mounts the sidebar as a static, column-reserving dock by
 * wrapping Pi's chat/pending/status root containers. This intentionally avoids
 * overlays because overlays hide chat content instead of reserving space.
 */
export function installSidebar(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;
	let memoryCache: SidebarMemoryCache | undefined;
	let activeMetricsHud: MetricsHud | undefined;
	let activeSubTab: SidebarSubTab = "CONTEXT";

	pi.registerShortcut("ctrl+1", {
		description: "sidebar: show CONTEXT sub-tab",
		handler: () => {
			activeSubTab = "CONTEXT";
			requestRender?.();
		},
	});
	pi.registerShortcut("ctrl+2", {
		description: "sidebar: show MEMORY sub-tab",
		handler: () => {
			activeSubTab = "MEMORY";
			requestRender?.();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		activeSubTab = "CONTEXT";
		memoryCache = createSidebarMemoryCache(createRemnicMemoryClient());

		ctx.ui.setWidget("sumocode-sidebar-dock", (tui): Component & { dispose(): void } => {
			// `requestRender(false)` lets Pi's differential renderer diff the sidebar
			// region and emit only changed cells. The hot driver of this trigger is
			// MetricsHud ticking every 1s — with `force = true`, each tick forces a
			// full-screen repaint (~25 KB of ANSI/sec idle drain measured in -d).
			// Sidebar updates do NOT scroll chat, so there are no seam fragments to
			// mask. Chat-scroll force-redraws stay in chat-viewport-controller.ts
			// (see #161 Slice B for the proper owned-shell rework).
			requestRender = () => tui.requestRender();
			activeMetricsHud?.stop();
			const metricsHud = new MetricsHud();
			activeMetricsHud = metricsHud;
			const metricsHudDisabled = process.env.SUMOCODE_DISABLE_METRICS_HUD === "1";
			logDiagnostic("sidebar_metrics_hud", { disabled: metricsHudDisabled });
			if (!metricsHudDisabled) {
				metricsHud.start(() => {
					if (sessionHasMessages(ctx)) requestRender?.();
				});
			}
			const sidebarComponent: Component = {
				invalidate(): void {},
				render(width: number): string[] {
					const lines = renderSidebar(
						snapshotFromContext(ctx, memoryCache?.snapshot() ?? { memory: [] }, activeSubTab, metricsHud.snapshot()),
						width,
					);
					const terminalRows = (tui.terminal as { rows?: number } | undefined)?.rows ?? lines.length;
					const targetRows = Math.max(lines.length, sidebarOverlayTargetRows(terminalRows));
					return [
						...lines,
						...Array.from({ length: Math.max(0, targetRows - lines.length) }, () => surfaceLine("", width)),
					];
				},
			};
			// Owned-shell mounts the sidebar as a real Yoga sibling of the chat
			// region. Publish the component to the runtime so it can pin its
			// columns structurally instead of relying on overlay compositing
			// (which is unsafe across chat scroll, resize, and full-frame diff).
			const runtime = getActiveSumoRuntime();
			const overlay = runtime
				? undefined
				: installNonCapturingSidebarOverlay(tui, sidebarComponent, () => sessionHasMessages(ctx));
			if (runtime) {
				runtime.setSidebarComponent(sidebarComponent, (cols) => cols >= SIDEBAR_MIN_TERMINAL_WIDTH && sessionHasMessages(ctx));
			}
			return {
				invalidate(): void {},
				render(): string[] {
					return [];
				},
				dispose(): void {
					metricsHud.stop();
					if (activeMetricsHud === metricsHud) activeMetricsHud = undefined;
					overlay?.hide();
					runtime?.setSidebarComponent(undefined);
					requestRender = undefined;
				},
			};
		});
	});

	pi.on("message_start", (event) => {
		const prompt = messageText(event.message);
		if (!prompt) return;
		memoryCache?.schedule(prompt, () => requestRender?.());
	});

	// Kick a render whenever counters or cost might have moved.
	pi.on("agent_end", () => requestRender?.());
	pi.on("tool_result", () => requestRender?.());
}
