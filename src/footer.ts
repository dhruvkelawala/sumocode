import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Pi's `ThinkingLevel` union, inlined to avoid pulling in `pi-agent-core`
 * as a direct dep. Mirrors the upstream definition exactly.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
import { getSessionUsage as getCachedSessionUsage, sessionHasMessages as cachedSessionHasMessages, linkGitBranchProvider } from "./session-cache.js";
import { activeThemeColors, type SumoCodeState } from "./themes/index.js";
import { VOICE } from "./voice.js";

type Usage = {
	input: number;
	output: number;
	cost: number;
};

export type FooterSnapshot = {
	cwd: string;
	branch: string | null;
	inputTokens: number;
	outputTokens: number;
	contextTokens?: number;
	contextWindow?: number;
	costUsd: number;
	state: SumoCodeState;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	/**
	 * When true, an additional dim version line is rendered below the main
	 * footer row. Per Q5.2, this only happens on the splash empty state.
	 */
	isSplash?: boolean;
};

/**
 * SumoCode version line for splash state (Q5.2 from CATHEDRAL_DECISIONS.md).
 */
export const SPLASH_VERSION_LINE = "SUMOCODE V0.3.0 · CATHEDRAL · 160 × 45 MONOSPACE";

type GitRunner = (args: string[], cwd: string) => string;

const RESET = "\u001b[0m";
const SPLASH_VERSION_TOP_GAP_ROWS = 2;
const SPLASH_VERSION_BOTTOM_GAP_ROWS = 7;
const FOOTER_HORIZONTAL_PADDING = 1;

export function colorHex(text: string, hex: string): string {
	const normalized = hex.replace("#", "");
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return `\u001b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

export function formatTokenCount(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return Math.round(count).toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwd(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
	// Outside $HOME (e.g. /Volumes/.../sumocode), show only the project basename
	// per DESIGN.md §4 footer spec.
	return basename(cwd) || cwd;
}

export function resolveGitBranch(cwd: string, runGit: GitRunner = defaultGitRunner): string | null {
	try {
		return runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd).trim() || null;
	} catch {
		try {
			const detached = runGit(["rev-parse", "--short", "HEAD"], cwd).trim();
			return detached ? "detached" : null;
		} catch {
			return null;
		}
	}
}

/**
 * F1 two-zone footer layout (Element 5 from CATHEDRAL_DECISIONS.md).
 *
 *   left zone  = agent state:    ● <STATE> · <model> · <thinking>
 *   right zone = session metrics: <ctx>/<window> · $<cost>
 *
 * Zones are separated by spaces sized to fill width. Project/branch are not
 * rendered here: sidebar owns them when visible, and the hint row owns them
 * when the sidebar is hidden.
 */
export function formatFooterLine(snapshot: FooterSnapshot, width = 160): string {
	const pad = width > FOOTER_HORIZONTAL_PADDING * 2 ? FOOTER_HORIZONTAL_PADDING : 0;
	const contentWidth = Math.max(0, width - pad * 2);
	const inner = formatFooterLineInner(snapshot, contentWidth);
	if (pad === 0) return inner;
	return `${" ".repeat(pad)}${padAnsiToWidth(inner, contentWidth)}${" ".repeat(pad)}`;
}

function padAnsiToWidth(line: string, width: number): string {
	const visible = visibleWidth(line);
	if (visible >= width) return truncateToWidth(line, width);
	return `${line}${" ".repeat(width - visible)}`;
}

function formatFooterLineInner(snapshot: FooterSnapshot, width: number): string {
	const dot = colorHex("●", activeThemeColors().states[snapshot.state]);
	const stateLabel = colorHex(VOICE.status[snapshot.state], activeThemeColors().foreground);
	const model = colorHex(snapshot.modelId, activeThemeColors().foreground);
	const thinking = colorHex(snapshot.thinkingLevel, activeThemeColors().foreground);
	const sep = colorHex(" · ", activeThemeColors().foregroundDim);

	const leftZone = [`${dot} ${stateLabel}`, model, thinking].join(sep);
	const leftLen = visibleWidth(leftZone);

	const contextTokens = snapshot.contextTokens ?? snapshot.inputTokens + snapshot.outputTokens;
	const contextWindow = snapshot.contextWindow ?? 0;
	const tokensText = contextWindow > 0
		? `${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)}`
		: formatTokenCount(contextTokens);
	const tokens = colorHex(tokensText, activeThemeColors().foreground);
	const cost = colorHex(`$${snapshot.costUsd.toFixed(2)}`, activeThemeColors().foreground);

	// Build right zone progressively, dropping rightmost fields if they don't fit.
	const rightCandidates: string[][] = [
		[tokens, cost],
		[tokens],
		[],
	];

	const MIN_GAP = 3; // minimum spaces between zones
	for (const candidate of rightCandidates) {
		const rightZone = candidate.join(sep);
		const rightLen = visibleWidth(rightZone);
		const totalNeeded = leftLen + (rightLen > 0 ? MIN_GAP + rightLen : 0);
		if (totalNeeded <= width) {
			if (rightLen === 0) {
				return truncateToWidth(leftZone, width);
			}
			const gap = width - leftLen - rightLen;
			return `${leftZone}${" ".repeat(gap)}${rightZone}`;
		}
	}

	// Fallback: even just the left zone overflows; truncate it.
	return truncateToWidth(leftZone, width);
}

/**
 * Render the splash-only bottom version line. Returns a single dim row
 * centered horizontally at the requested width. Empty string if too narrow.
 */
export function renderSplashVersionLine(width: number): string {
	if (width <= 0 || SPLASH_VERSION_LINE.length > width) return "";
	const padLeft = Math.floor((width - SPLASH_VERSION_LINE.length) / 2);
	const padRight = width - SPLASH_VERSION_LINE.length - padLeft;
	const dim = colorHex(SPLASH_VERSION_LINE, activeThemeColors().foregroundDim);
	return `${" ".repeat(padLeft)}${dim}${" ".repeat(padRight)}`;
}

/**
 * Render the full footer block. Active state keeps the status footer. Splash
 * matches Bible Element 3: no status footer, just breathing rows and the
 * centered version line below the invocation hint row.
 *
 * Active bottom breathing rows are owned by the retained shell layout shim, not
 * by this component. Keeping the footer to one semantic row lets plain Pi and
 * SumoTUI share the same footer renderer while SumoTUI owns terminal-bottom
 * placement.
 */
export function renderFooterBlock(snapshot: FooterSnapshot, width = 160): string[] {
	if (!snapshot.isSplash) return [formatFooterLine(snapshot, width)];
	const version = renderSplashVersionLine(width);
	return [
		...Array.from({ length: SPLASH_VERSION_TOP_GAP_ROWS }, () => ""),
		...(version === "" ? [] : [version]),
		...Array.from({ length: SPLASH_VERSION_BOTTOM_GAP_ROWS }, () => ""),
	];
}

export function installFooter(pi: ExtensionAPI): void {
	let state: SumoCodeState = "idle";
	let render: (() => void) | undefined;

	const setState = (next: SumoCodeState): void => {
		state = next;
		render?.();
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, _theme, footerData) => {
			render = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(render);

			// Bridge Pi's file-watcher-driven branch provider into the shared
			// session-cache so the sidebar and input-hints also see live updates
			// instead of stale session_start/agent_end snapshots.
			const unlinkBranchProvider = linkGitBranchProvider(footerData);

			return {
				dispose(): void {
					unsubscribe();
					unlinkBranchProvider();
					if (render) render = undefined;
				},
				invalidate(): void {},
				render(width: number): string[] {
					return renderFooterBlock(createSnapshot(pi, ctx, footerData.getGitBranch(), state), width);
				},
			};
		});
	});

	pi.on("before_agent_start", () => setState("thinking"));
	pi.on("agent_start", () => setState("thinking"));
	pi.on("tool_call", () => setState("tool"));
	pi.on("tool_result", () => setState("thinking"));
	pi.on("agent_end", () => setState("idle"));
}

function createSnapshot(pi: ExtensionAPI, ctx: ExtensionContext, branch: string | null, state: SumoCodeState): FooterSnapshot {
	const usage = getSessionUsage(ctx);

	return {
		cwd: ctx.cwd,
		branch,
		inputTokens: usage.input,
		outputTokens: usage.output,
		contextTokens: getContextTokens(ctx, usage),
		contextWindow: getContextWindow(ctx),
		costUsd: usage.cost,
		state,
		modelId: ctx.model?.id ?? "no-model",
		thinkingLevel: getThinkingLevel(pi, ctx),
		isSplash: !sessionHasMessages(ctx),
	};
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return cachedSessionHasMessages(ctx);
	} catch {
		return false;
	}
}

function getThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): ThinkingLevel {
	// Pi 0.74.0 exposes the thinking-level getter on `ExtensionAPI` (the `pi`
	// parameter of installFooter), NOT on `ExtensionContext` (`ctx`). The
	// canonical reference is
	// `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:849`
	// which lives inside `interface ExtensionAPI` (line 768).
	//
	// PR #60 mistakenly probed `ctx.getThinkingLevel()` and silently fell back
	// to "medium" because that property doesn't exist on ctx. This call site
	// fixes the lookup to use `pi.getThinkingLevel()`.
	try {
		const piGetter = (pi as { getThinkingLevel?: () => ThinkingLevel }).getThinkingLevel;
		if (typeof piGetter === "function") return piGetter.call(pi);
	} catch {
		// fall through
	}
	// Legacy probe (kept so older Pi versions / mocked contexts still work).
	const ctxGetter = (ctx as { getThinkingLevel?: () => ThinkingLevel }).getThinkingLevel;
	if (typeof ctxGetter === "function") {
		try {
			return ctxGetter.call(ctx);
		} catch {
			// fall through
		}
	}
	const legacy = (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel;
	return legacy ?? "medium";
}

function getContextTokens(ctx: ExtensionContext, usage: Usage): number {
	try {
		const contextUsage = (ctx as { getContextUsage?: () => { tokens?: number } | undefined }).getContextUsage?.();
		if (typeof contextUsage?.tokens === "number") return contextUsage.tokens;
	} catch {
		// fall through
	}
	return usage.input + usage.output;
}

function getContextWindow(ctx: ExtensionContext): number {
	try {
		const contextUsage = (ctx as { getContextUsage?: () => { contextWindow?: number } | undefined }).getContextUsage?.();
		if (typeof contextUsage?.contextWindow === "number") return contextUsage.contextWindow;
	} catch {
		// fall through
	}
	return ctx.model?.contextWindow ?? 0;
}

function getSessionUsage(ctx: ExtensionContext): Usage {
	const cached = getCachedSessionUsage(ctx);
	return { input: cached.input, output: cached.output, cost: cached.cost };
}

function defaultGitRunner(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}
