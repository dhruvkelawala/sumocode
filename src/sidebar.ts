import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { resolveGitBranch } from "./footer.js";
import { createRemnicMemoryClient, type RemnicMemoryClient } from "./memory.js";
import { MetricsHud } from "./sumo-tui/cathedral/metrics-hud.js";
import {
	SIDEBAR_SUB_TABS,
	renderRegistrySidebarLines,
	type McpServerSnapshot,
	type RegistrySidebarSnapshot,
	type SidebarSessionSnapshot,
	type SidebarSubTab,
} from "./sumo-tui/cathedral/sidebar-rendering.js";
import { surfaceLine } from "./sumo-tui/cathedral/ansi.js";
import { installNonCapturingSidebarOverlay } from "./sidebar-placement.js";
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
	{ name: "chrome-devtools", status: "idle" },
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

export function createSidebarMemoryCache(
	memoryClient: Pick<RemnicMemoryClient, "query">,
	debounceMs = SIDEBAR_MEMORY_DEBOUNCE_MS,
): SidebarMemoryCache {
	let memory: readonly string[] = [];
	let memoryUnavailable = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;

	function setSnapshot(nextMemory: readonly string[], nextUnavailable: boolean): boolean {
		const changed = memoryUnavailable !== nextUnavailable || memory.length !== nextMemory.length || memory.some((item, index) => item !== nextMemory[index]);
		memory = nextMemory;
		memoryUnavailable = nextUnavailable;
		return changed;
	}

	async function refresh(prompt: string): Promise<boolean> {
		const run = ++generation;
		try {
			const facts = await memoryClient.query(prompt, MEMORY_DISPLAY_LIMIT);
			if (run !== generation) return false;
			return setSnapshot(facts.map((fact) => fact.text), false);
		} catch {
			if (run !== generation) return false;
			return setSnapshot([], true);
		}
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
	return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

function snapshotFromContext(
	ctx: ExtensionContext,
	memorySnapshot: Pick<SidebarSnapshot, "memory" | "memoryUnavailable">,
	activeSubTab: SidebarSubTab,
	metrics: SidebarSnapshot["metrics"],
): SidebarSnapshot {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		input += entry.message.usage.input;
		output += entry.message.usage.output;
		cost += entry.message.usage.cost.total;
	}

	const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const branch = resolveGitBranch(ctx.cwd) ?? undefined;

	return {
		projectName: basename(ctx.cwd) || ctx.cwd,
		branch,
		inputTokens: input,
		outputTokens: output,
		contextWindow,
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
			requestRender = () => tui.requestRender(true);
			activeMetricsHud?.stop();
			const metricsHud = new MetricsHud();
			activeMetricsHud = metricsHud;
			metricsHud.start(() => {
				if (sessionHasMessages(ctx)) requestRender?.();
			});
			const sidebarComponent: Component = {
				invalidate(): void {},
				render(width: number): string[] {
					return renderSidebar(
						snapshotFromContext(ctx, memoryCache?.snapshot() ?? { memory: [] }, activeSubTab, metricsHud.snapshot()),
						width,
					);
				},
			};
			const overlay = installNonCapturingSidebarOverlay(tui, sidebarComponent, () => sessionHasMessages(ctx));
			return {
				invalidate(): void {},
				render(): string[] {
					return [];
				},
				dispose(): void {
					metricsHud.stop();
					if (activeMetricsHud === metricsHud) activeMetricsHud = undefined;
					overlay.hide();
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
