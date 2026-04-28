import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * Pi's `ThinkingLevel` union, inlined to avoid pulling in `pi-agent-core`
 * as a direct dep. Mirrors the upstream definition exactly.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
import { CATHEDRAL_TOKENS, type SumoCodeState } from "./tokens.js";
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
export const SPLASH_VERSION_LINE = "SUMOCODE V0.2.0 · CATHEDRAL · 160 × 45 MONOSPACE";

type GitRunner = (args: string[], cwd: string) => string;

const RESET = "\u001b[0m";

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
 *   right zone = session metrics: <project> (<branch>) · ↑<in> ↓<out> · $<cost>
 *
 * Zones are separated by spaces sized to fill width. At narrow widths the
 * right zone collapses field-by-field (cost → tokens → path) before the
 * whole right zone disappears.
 *
 * Note: ctx% deliberately NOT in footer (lives in sidebar CONTEXT sub-tab).
 */
export function formatFooterLine(snapshot: FooterSnapshot, width = 160): string {
	const dot = colorHex("●", CATHEDRAL_TOKENS.colors.states[snapshot.state]);
	const stateLabel = colorHex(VOICE.status[snapshot.state], CATHEDRAL_TOKENS.colors.foreground);
	const model = colorHex(snapshot.modelId, CATHEDRAL_TOKENS.colors.foregroundDim);
	const thinking = colorHex(snapshot.thinkingLevel, CATHEDRAL_TOKENS.colors.foregroundDim);
	const sep = colorHex(" · ", CATHEDRAL_TOKENS.colors.divider);

	const leftZone = [`${dot} ${stateLabel}`, model, thinking].join(sep);
	const leftLen = visibleWidth(leftZone);

	const branch = snapshot.branch ? ` (${snapshot.branch})` : "";
	const path = colorHex(`${formatCwd(snapshot.cwd)}${branch}`, CATHEDRAL_TOKENS.colors.foreground);
	const tokens = colorHex(
		`↑${formatTokenCount(snapshot.inputTokens)} ↓${formatTokenCount(snapshot.outputTokens)}`,
		CATHEDRAL_TOKENS.colors.foregroundDim,
	);
	const cost = colorHex(`$${snapshot.costUsd.toFixed(2)}`, CATHEDRAL_TOKENS.colors.foregroundDim);

	// Build right zone progressively, dropping rightmost fields if they don't fit.
	const rightCandidates: string[][] = [
		[path, tokens, cost],   // full
		[path, tokens],         // drop cost
		[path],                 // drop tokens too
		[],                     // drop everything
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
	const dim = colorHex(SPLASH_VERSION_LINE, CATHEDRAL_TOKENS.colors.foregroundDim);
	return `${" ".repeat(padLeft)}${dim}${" ".repeat(padRight)}`;
}

/**
 * Render the full footer block. 1 line in active state, 2 lines on splash
 * (footer + version line).
 */
export function renderFooterBlock(snapshot: FooterSnapshot, width = 160): string[] {
	const footer = formatFooterLine(snapshot, width);
	if (!snapshot.isSplash) return [footer];
	const version = renderSplashVersionLine(width);
	return version === "" ? [footer] : [footer, version];
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

			return {
				dispose(): void {
					unsubscribe();
					if (render) render = undefined;
				},
				invalidate(): void {},
				render(width: number): string[] {
					return [formatFooterLine(createSnapshot(ctx, footerData.getGitBranch(), state), width)];
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

function createSnapshot(ctx: ExtensionContext, branch: string | null, state: SumoCodeState): FooterSnapshot {
	const usage = getSessionUsage(ctx);

	return {
		cwd: ctx.cwd,
		branch,
		inputTokens: usage.input,
		outputTokens: usage.output,
		costUsd: usage.cost,
		state,
		modelId: ctx.model?.id ?? "no-model",
		thinkingLevel: getThinkingLevel(ctx),
		isSplash: !sessionHasMessages(ctx),
	};
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	} catch {
		return false;
	}
}

function getThinkingLevel(ctx: ExtensionContext): ThinkingLevel {
	// Pi 0.70.2+ exposes thinking level via the public extension API:
	// `ctx.getThinkingLevel(): ThinkingLevel` (see
	// node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:849).
	// Earlier versions only had a non-existent `ctx.thinkingLevel` property
	// which silently fell back to "medium" — that's the bug we're fixing.
	try {
		const getter = (ctx as { getThinkingLevel?: () => ThinkingLevel }).getThinkingLevel;
		if (typeof getter === "function") return getter.call(ctx);
	} catch {
		// fall through to legacy probe
	}
	const legacy = (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel;
	return legacy ?? "medium";
}

function getSessionUsage(ctx: ExtensionContext): Usage {
	let input = 0;
	let output = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		input += entry.message.usage.input;
		output += entry.message.usage.output;
		cost += entry.message.usage.cost.total;
	}

	return { input, output, cost };
}

function defaultGitRunner(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}
