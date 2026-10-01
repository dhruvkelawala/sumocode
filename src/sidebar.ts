import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getCachedMcpRoster, setMcpDiagnosticHandler } from "./mcp-config-reader.js";
import {
	getGitBranch as getCachedGitBranch,
	getSessionUsage as getCachedSessionUsage,
	sessionHasMessages as cachedSessionHasMessages,
} from "./session-cache.js";
import { MetricsHud } from "./sumo-tui/cathedral/metrics-hud.js";
import {
	renderRegistrySidebarLines,
	type McpServerSnapshot,
	type RegistrySidebarSnapshot,
	type SidebarSessionSnapshot,
} from "./sumo-tui/cathedral/sidebar-rendering.js";
import { surfaceLine } from "./sumo-tui/cathedral/ansi.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { installNonCapturingSidebarOverlay, sidebarOverlayTargetRows } from "./sidebar-placement.js";
export {
	SIDEBAR_MIN_TERMINAL_WIDTH,
	SIDEBAR_WIDTH,
	StaticSidebarDock,
	chooseSidebarAnchor,
	dockStaticSidebar,
	type SidebarAnchor,
} from "./sidebar-placement.js";

/**
 * Deterministic MCP roster used by the visual-v2 fixture lane. The
 * fixture lane needs a stable, reproducible roster so cell-diff golden
 * comparisons stay deterministic; this constant is intentionally NOT
 * what the runtime sidebar shows. Runtime callers go through
 * `mcp-config-reader.ts` instead, which reads `pi-mcp-adapter`'s real
 * config files.
 */
export const PLACEHOLDER_MCP: readonly McpServerSnapshot[] = [
	{ name: "github", status: "idle" },
	{ name: "stitch", status: "ok" },
	{ name: "context7", status: "idle" },
	{ name: "chrome-dev", status: "idle" },
];

function resolvePiAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// Wire pi-mcp-adapter `imports` diagnostics through the existing diagnostics
// pipeline. Module-level so the handler is set exactly once when sidebar.ts
// loads, before any sidebar snapshot triggers a config read.
setMcpDiagnosticHandler((event) => {
	logDiagnostic(event.type, { path: event.path, importsCount: event.importsCount });
});

export type { McpServerSnapshot, SidebarSessionSnapshot };

export type SidebarSnapshot = RegistrySidebarSnapshot;

export function renderSidebar(snapshot: SidebarSnapshot, width: number): string[] {
	return renderRegistrySidebarLines(snapshot, width).map((line) => surfaceLine(line, width));
}

export type SidebarPublication = {
	readonly component: Component;
	readonly isVisible: (cols: number, rows: number) => boolean;
};

class SidebarComponent implements Component {
	public constructor(
		private readonly loadSnapshot: () => SidebarSnapshot,
		private readonly extra?: Component,
		private readonly targetRows?: () => number,
	) {}

	public invalidate(): void {
		this.extra?.invalidate?.();
	}

	public render(width: number): string[] {
		const lines = renderSidebar(this.loadSnapshot(), width);
		const extraLines = this.extra?.render(width) ?? [];
		const rows = extraLines.length > 0 ? [...lines, ...extraLines] : lines;
		const targetRows = this.targetRows?.() ?? rows.length;
		return [
			...rows,
			...Array.from({ length: Math.max(0, targetRows - rows.length) }, () => surfaceLine("", width)),
		];
	}
}

export function createSidebarComponent(
	loadSnapshot: () => SidebarSnapshot,
	extra?: Component,
	targetRows?: () => number,
): Component {
	return new SidebarComponent(loadSnapshot, extra, targetRows);
}

export function createSidebarPublication(
	loadSnapshot: () => SidebarSnapshot,
	isVisible: (cols: number, rows: number) => boolean,
	extra?: Component,
	targetRows?: () => number,
): SidebarPublication {
	return {
		component: createSidebarComponent(loadSnapshot, extra, targetRows),
		isVisible,
	};
}

function isNumber(value: number | null | undefined): value is number {
	return typeof value === "number";
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	return cachedSessionHasMessages(ctx);
}

function snapshotFromContext(
	ctx: ExtensionContext,
	metrics: SidebarSnapshot["metrics"],
): SidebarSnapshot {
	const { input, output, cost } = getCachedSessionUsage(ctx);

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	// Current context tokens from Pi's live context usage API — same source as the footer.
	// Falls back to cumulative input+output only if the API is unavailable.
	const currentContextTokens = isNumber(contextUsage?.tokens) ? contextUsage.tokens : undefined;
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
		mcpServers: getCachedMcpRoster({ cwd: ctx.cwd, piAgentDir: resolvePiAgentDir() }),
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
	let activeMetricsHud: MetricsHud | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

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
			const sidebarComponent = createSidebarComponent(
				() => snapshotFromContext(ctx, metricsHud.snapshot()),
				undefined,
				// SAFETY: the TUI terminal exposes an optional rows field; a missing
				// value falls back to the default overlay row target.
				() => sidebarOverlayTargetRows((tui.terminal as { rows?: number } | undefined)?.rows ?? 0),
			);
			const overlay = installNonCapturingSidebarOverlay(tui, sidebarComponent, () => sessionHasMessages(ctx));
			return {
				invalidate(): void {},
				render(): string[] {
					return [];
				},
				dispose(): void {
					metricsHud.stop();
					if (activeMetricsHud === metricsHud) activeMetricsHud = undefined;
					overlay?.hide();
					requestRender = undefined;
				},
			};
		});
	});

	// Kick a render whenever counters or cost might have moved.
	pi.on("agent_end", () => requestRender?.());
	pi.on("tool_result", () => requestRender?.());
}
