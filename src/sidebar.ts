import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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

/**
 * Threshold below which the sidebar hides itself. Per DESIGN.md §8
 * (Responsive), the wide layout is ≥ 120 cols: chat ~70 cols + 1 gutter +
 * 49 sidebar fits comfortably. Below this we collapse to chat-only and let
 * sidebar info come through `/sumo:memory` etc.
 */
export const SIDEBAR_MIN_TERMINAL_WIDTH = 120;
/** Render width for the sidebar overlay (DESIGN.md §5 — cols 112..160 in the wide layout). */
export const SIDEBAR_WIDTH = 49;
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

export type SidebarAnchor = "right-center" | "top-right" | "bottom-right";

/**
 * Pick a sidebar anchor responsive to terminal aspect ratio. Override always
 * wins so per-machine `~/.sumocode/local-config.json` can pin a value.
 */
export function chooseSidebarAnchor(
	termWidth: number,
	termHeight: number,
	override?: SidebarAnchor,
): SidebarAnchor {
	if (override) return override;
	if (termHeight > termWidth * 1.4) return "top-right";
	return "right-center";
}

export function renderSidebar(snapshot: SidebarSnapshot, width: number): string[] {
	return renderRegistrySidebarLines(snapshot, width).map((line) => surfaceLine(line, width));
}

const STATIC_SIDEBAR_GUTTER = 1;
const STATIC_SIDEBAR_DOCK_MARKER = Symbol("sumocode.staticSidebarDock");

type MutableTuiRoot = {
	children: Component[];
	requestRender(): void;
};

function padToWidth(line: string, width: number): string {
	const truncated = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
	const padding = Math.max(0, width - visibleWidth(truncated));
	return `${truncated}${" ".repeat(padding)}`;
}

function renderComponents(components: readonly Component[], width: number): string[] {
	return components.flatMap((component) => component.render(width));
}

/**
 * Static two-column dock used as a guarded workaround for Pi 0.70.x not
 * exposing a public side-panel API. It renders chat/pending/status at a
 * reduced left-column width and appends the sidebar in reserved right columns.
 *
 * Cathedral splash discipline: when `shouldShowSidebar()` returns false (no
 * messages yet), the dock renders its main components at full width and skips
 * the sidebar column entirely. The sidebar only earns its column when there is
 * chat to contextualize.
 */
export class StaticSidebarDock implements Component {
	readonly [STATIC_SIDEBAR_DOCK_MARKER] = true;

	constructor(
		private readonly mainComponents: readonly Component[],
		private readonly sidebarComponent: Component,
		private readonly shouldShowSidebar: () => boolean,
	) {}

	invalidate(): void {
		for (const component of [...this.mainComponents, this.sidebarComponent]) {
			component.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (width < SIDEBAR_MIN_TERMINAL_WIDTH || !this.shouldShowSidebar()) {
			return renderComponents(this.mainComponents, width);
		}

		const mainWidth = Math.max(1, width - SIDEBAR_WIDTH - STATIC_SIDEBAR_GUTTER);
		const mainLines = renderComponents(this.mainComponents, mainWidth);
		const sidebarLines = this.sidebarComponent.render(SIDEBAR_WIDTH);
		// The dock is part of Pi's vertical root flow above the editor/footer. Its
		// height must be dictated by the main column (header + retained chat +
		// status), not by sidebar content. If the sidebar is taller, growing the
		// dock pushes the input/footer down and makes the whole layout bounce during
		// chat scroll/full redraw. Treat the sidebar as clipped to the main column.
		const rowCount = mainLines.length;
		const lines: string[] = [];

		// Pre-build a surface-bg-painted blank sidebar row so rows where the
		// sidebar has no content still cover the right 49 cols with the cathedral
		// surface (#241D17). Without this, cells past the last sidebar line fall
		// back to terminal-default bg — visible as black bands when the chat
		// content underneath is taller than the sidebar (e.g., long tool outputs).
		// surfaceLine pads to width and wraps in cathedral surface bg + fg ANSI.
		const blankSidebarRow = surfaceLine("", SIDEBAR_WIDTH);

		for (let i = 0; i < rowCount; i++) {
			const left = padToWidth(mainLines[i] ?? "", mainWidth);
			const right = i < sidebarLines.length
				? padToWidth(sidebarLines[i]!, SIDEBAR_WIDTH)
				: blankSidebarRow;
			lines.push(`${left}${" ".repeat(STATIC_SIDEBAR_GUTTER)}${right}`);
		}

		return lines;
	}
}

function isStaticSidebarDock(component: Component): component is StaticSidebarDock {
	return (component as Partial<Record<typeof STATIC_SIDEBAR_DOCK_MARKER, boolean>>)[STATIC_SIDEBAR_DOCK_MARKER] === true;
}

/**
 * Guarded root-container surgery. Pi currently gives extensions no public API
 * for static side panels, but `TUI` is a public `Container` and exposes its
 * children array. We only mutate the expected root shape and return a restore
 * callback so reload/shutdown can put Pi's tree back exactly as it was.
 *
 * The dock wraps header + chat + pending + status (everything above the
 * editor) so that the splash, which lives in the header, also respects the
 * reserved sidebar column when the sidebar becomes visible.
 */
export function dockStaticSidebar(
	tui: MutableTuiRoot,
	sidebarComponent: Component,
	shouldShowSidebar: () => boolean,
): (() => void) | undefined {
	if (tui.children.some(isStaticSidebarDock)) return undefined;
	if (tui.children.length < 5) return undefined;

	const [header, chat, pending, status, ...rest] = tui.children;
	if (!header || !chat || !pending || !status || rest.length === 0) return undefined;

	const dock = new StaticSidebarDock([header, chat, pending, status], sidebarComponent, shouldShowSidebar);
	const original = [...tui.children];
	tui.children.splice(0, 4, dock);
	tui.requestRender();

	return () => {
		const dockIndex = tui.children.indexOf(dock);
		if (dockIndex !== -1) {
			tui.children.splice(dockIndex, 1, ...original.slice(0, 4));
		}
	};
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
			requestRender = () => tui.requestRender();
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
			const restore = dockStaticSidebar(tui, sidebarComponent, () => sessionHasMessages(ctx));
			return {
				invalidate(): void {},
				render(): string[] {
					return [];
				},
				dispose(): void {
					metricsHud.stop();
					if (activeMetricsHud === metricsHud) activeMetricsHud = undefined;
					restore?.();
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
