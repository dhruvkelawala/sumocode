import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Pi's thinking-level union, aliased from the canonical `@earendil-works/pi-ai`
 * definition (`off | minimal | low | medium | high | xhigh | max`) so new
 * upstream levels flow in automatically. Do not redeclare this union by hand.
 */
export type ThinkingLevel = ModelThinkingLevel;
import { formatClaudeAccountChip } from "./config/claude-account-status.js";
import { resolveSessionClaudeAccount } from "./claude-account-status-publication.js";
import { shouldApplyFastMode, type FastModeState } from "./fast-mode.js";
import { getSessionUsage as getCachedSessionUsage, sessionHasMessages as cachedSessionHasMessages, linkGitBranchProvider } from "./session-cache.js";
import { activeThemeColors, type SumoCodeState } from "./themes/index.js";
import { VOICE } from "./voice.js";

/** The render-facing pair the footer paints; the resolver owns the provider id. */
export interface FooterClaudeAccount {
	readonly label: string;
	readonly active: boolean;
}

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
	/** When true, append a `fast` label after thinking when active fast mode applies. */
	showFastMode?: boolean;
	/**
	 * The Claude account this session's Claude models resolve to. Dim when a
	 * Claude task would resolve here, bright when it is live; absent when no
	 * Claude account is configured.
	 */
	claudeAccount?: FooterClaudeAccount;
	/**
	 * When true, an additional dim version line is rendered below the main
	 * footer row. Per Q5.2, this only happens on the splash empty state.
	 */
	isSplash?: boolean;
};

/**
 * SumoCode version line for splash state (Q5.2 from CATHEDRAL_DECISIONS.md).
 */
export const SPLASH_VERSION_LINE = "SUMOCODE V0.6.1 · CATHEDRAL · 160 × 45 MONOSPACE";

type GitRunner = (args: string[], cwd: string) => string;

const RESET = "\u001b[0m";
const SPLASH_VERSION_TOP_GAP_ROWS = 2;
const SPLASH_VERSION_BOTTOM_GAP_ROWS = 7;
const FOOTER_HORIZONTAL_PADDING = 1;
/** `claude ` plus the eight-column label budget the resolver also applies. */
const CLAUDE_ACCOUNT_CHIP_COLUMNS = 15;
const CLAUDE_ACCOUNT_CHIP_TRUNCATION_MARKER = "…";

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
 *   left zone  = agent state:    ● <STATE> · <model> · <thinking> [· fast] [· claude <account>]
 *   right zone = session metrics: <ctx>/<window> · $<cost>
 *
 * The account segment is the last left field dropped when width runs out: it is
 * the one fact the model id cannot supply once the session is on another
 * provider, which is exactly when the owner needs it.
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
	const fast = snapshot.showFastMode ? colorHex("fast", activeThemeColors().foreground) : undefined;
	// The resolver clips by grapheme so a label can never split mid-character;
	// the column budget is the footer's to enforce, since only it knows how wide
	// a grapheme paints (a CJK label is two columns per character).
	const account = snapshot.claudeAccount
		? colorHex(
			truncateToWidth(formatClaudeAccountChip(snapshot.claudeAccount), CLAUDE_ACCOUNT_CHIP_COLUMNS, CLAUDE_ACCOUNT_CHIP_TRUNCATION_MARKER),
			snapshot.claudeAccount.active ? activeThemeColors().foreground : activeThemeColors().foregroundDim,
		)
		: undefined;

	const statePart = `${dot} ${stateLabel}`;

	// Left ladder, richest first. The account segment outlives thinking and fast
	// because it is the only field the model id cannot imply once the session is
	// on a non-Claude provider.
	const leftCandidates = uniqueCandidates([
		[statePart, model, thinking, fast, account],
		[statePart, model, thinking, account],
		[statePart, model, account],
		[statePart, account],
		[statePart],
	]);

	const contextTokens = snapshot.contextTokens ?? snapshot.inputTokens + snapshot.outputTokens;
	const contextWindow = snapshot.contextWindow ?? 0;
	const tokensText = contextWindow > 0
		? `${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)}`
		: formatTokenCount(contextTokens);
	const tokens = colorHex(tokensText, activeThemeColors().foreground);
	const cost = colorHex(`$${snapshot.costUsd.toFixed(2)}`, activeThemeColors().foreground);

	// Right zone degrades first; the left degrades only when its own fields alone
	// cannot fit. Below that the ladder keeps the state and the account segment
	// ahead of the model id: the model is visible in the input hints and the
	// model picker, while the account is visible nowhere else on a non-Claude
	// model, and a session metric is not worth losing it for.
	const rightCandidates: string[][] = [
		[tokens, cost],
		[tokens],
		[],
	];

	const MIN_GAP = 3; // minimum spaces between zones
	for (const left of leftCandidates) {
		const leftZone = left.join(sep);
		const leftLen = visibleWidth(leftZone);
		for (const candidate of rightCandidates) {
			const rightZone = candidate.join(sep);
			const rightLen = visibleWidth(rightZone);
			const totalNeeded = leftLen + (rightLen > 0 ? MIN_GAP + rightLen : 0);
			if (totalNeeded > width) continue;
			if (rightLen === 0) return truncateToWidth(leftZone, width);
			return `${leftZone}${" ".repeat(width - leftLen - rightLen)}${rightZone}`;
		}
	}

	// Even the state label alone overflows; keep the state readable.
	return truncateToWidth(statePart, width);
}

/** Drops undefined fields and duplicate candidate rows, preserving order. */
function uniqueCandidates(rows: Array<Array<string | undefined>>): string[][] {
	const seen = new Set<string>();
	const result: string[][] = [];
	for (const row of rows) {
		const fields = row.filter((field): field is string => field !== undefined);
		const key = fields.join("\u0000");
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(fields);
	}
	return result;
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

export function installFooter(
	pi: ExtensionAPI,
	options: {
		fastModeState?: FastModeState;
		/** Subscription labels for extra Claude accounts, owned by the accounts config. */
		subscriptionLabel?: (providerId: string) => string | undefined;
		/** Injection seam; production reads the model registry and enabled patterns. */
		resolveClaudeAccount?: (ctx: ExtensionContext) => { label: string; active: boolean } | undefined;
	} = {},
): () => void {
	let state: SumoCodeState = "idle";
	let render: (() => void) | undefined;
	let activeCtx: ExtensionContext | undefined;
	let activeFooterData: Pick<ReadonlyFooterDataProvider, "getGitBranch"> | undefined;
	let claudeAccount: FooterClaudeAccount | undefined;
	// Memoized on purpose: the resolver reads settings.json, and the footer
	// re-renders on every requestRender.
	const resolveClaudeAccount =
		options.resolveClaudeAccount ?? ((ctx: ExtensionContext) => resolveSessionClaudeAccount(ctx, options.subscriptionLabel));
	const refreshClaudeAccount = (ctx: ExtensionContext): void => {
		const status = safeRead(() => resolveClaudeAccount(ctx), undefined);
		claudeAccount = status ? { label: status.label, active: status.active } : undefined;
	};

	const setState = (next: SumoCodeState): void => {
		state = next;
		render?.();
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		refreshClaudeAccount(ctx);
		activeCtx = ctx;

		ctx.ui.setFooter((tui, _theme, footerData) => {
			activeFooterData = footerData;
			const componentRender = (): void => tui.requestRender();
			render = componentRender;
			const unsubscribe = footerData.onBranchChange(componentRender);

			// Bridge Pi's file-watcher-driven branch provider into the shared
			// session-cache so the sidebar and input-hints also see live updates
			// instead of stale session_start/agent_end snapshots.
			const unlinkBranchProvider = linkGitBranchProvider(footerData);

			return {
				dispose(): void {
					unsubscribe();
					unlinkBranchProvider();
					if (render === componentRender) render = undefined;
					if (activeCtx === ctx) activeCtx = undefined;
					if (activeFooterData === footerData) activeFooterData = undefined;
				},
				invalidate(): void {},
				render(width: number): string[] {
					const renderCtx = resolveRenderContext(activeCtx, ctx);
					const branchProvider = activeFooterData ?? footerData;
					const branch = safeRead(() => branchProvider.getGitBranch(), null);
					return renderFooterBlock(createSnapshot(pi, renderCtx, branch, state, claudeAccount, options.fastModeState), width);
				},
			};
		});
	});

	pi.on("before_agent_start", () => setState("thinking"));
	pi.on("agent_start", () => setState("thinking"));
	pi.on("tool_call", () => setState("tool"));
	pi.on("tool_result", () => setState("thinking"));
	pi.on("agent_end", (_event, ctx) => {
		// `/accounts` renames write claude-accounts.json without a model change, so
		// the chip re-resolves once per turn boundary to pick the new label up.
		if (ctx.hasUI) refreshClaudeAccount(ctx);
		setState("idle");
	});
	pi.on("model_select", (_event, ctx) => {
		// Mirror session_start's guard: a headless session must not repaint the UI
		// footer's chip from its own context, nor pay for the registry read.
		if (!ctx.hasUI) return;
		refreshClaudeAccount(ctx);
		render?.();
	});

	return () => render?.();
}


function resolveRenderContext(...candidates: Array<ExtensionContext | undefined>): ExtensionContext | undefined {
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (!safeRead(() => {
			void candidate.cwd;
			return true;
		}, false)) continue;
		return candidate;
	}
	return undefined;
}

function createSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	branch: string | null,
	state: SumoCodeState,
	claudeAccount: FooterClaudeAccount | undefined,
	fastModeState?: FastModeState,
): FooterSnapshot {
	if (!ctx) {
		return {
			cwd: "",
			branch,
			inputTokens: 0,
			outputTokens: 0,
			contextTokens: 0,
			contextWindow: 0,
			costUsd: 0,
			state,
			modelId: "no-model",
			thinkingLevel: "medium",
			showFastMode: false,
			isSplash: false,
		};
	}

	const usage = getSessionUsage(ctx);
	const model = safeRead(() => ctx.model, undefined);

	return {
		cwd: safeRead(() => ctx.cwd, ""),
		branch,
		inputTokens: usage.input,
		outputTokens: usage.output,
		contextTokens: getContextTokens(ctx, usage),
		contextWindow: getContextWindow(ctx),
		costUsd: usage.cost,
		state,
		modelId: model?.id ?? "no-model",
		thinkingLevel: getThinkingLevel(pi, ctx),
		showFastMode: shouldShowFastModeInFooter(fastModeState, model),
		claudeAccount,
		isSplash: !sessionHasMessages(ctx),
	};
}

function shouldShowFastModeInFooter(fastModeState: FastModeState | undefined, model: ExtensionContext["model"] | undefined): boolean {
	return shouldApplyFastMode(fastModeState ?? { enabled: false, models: [] }, model);
}

function safeRead<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
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
		// SAFETY: duck-typed capability probe for optional Pi API across supported versions; typeof guard verifies callability before use.
		const piGetter = (pi as { getThinkingLevel?: () => ThinkingLevel }).getThinkingLevel;
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- capability probe for optional Pi API across supported versions
		if (typeof piGetter === "function") return piGetter.call(pi);
	} catch {
		// fall through
	}
	// Legacy probe (kept so older Pi versions / mocked contexts still work).
	try {
		// SAFETY: duck-typed capability probe for optional Pi API across supported versions; typeof guard verifies callability before use.
		const ctxGetter = (ctx as { getThinkingLevel?: () => ThinkingLevel }).getThinkingLevel;
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- capability probe for optional Pi API across supported versions
		if (typeof ctxGetter === "function") return ctxGetter.call(ctx);
	} catch {
		// fall through
	}
	// SAFETY: final fallback read of an optional field that older Pi contexts expose.
	return safeRead(() => (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel, undefined) ?? "medium";
}

function getContextTokens(ctx: ExtensionContext, usage: Usage): number {
	try {
		// SAFETY: duck-typed capability probe; every read is guarded below.
		const contextUsage = (ctx as { getContextUsage?: () => { tokens?: number } | undefined }).getContextUsage?.();
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- numeric guard on an optional Pi usage hook
		if (typeof contextUsage?.tokens === "number") return contextUsage.tokens;
	} catch {
		// fall through
	}
	return usage.input + usage.output;
}

function getContextWindow(ctx: ExtensionContext): number {
	try {
		// SAFETY: duck-typed capability probe; every read is guarded below.
		const contextUsage = (ctx as { getContextUsage?: () => { contextWindow?: number } | undefined }).getContextUsage?.();
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- numeric guard on an optional Pi usage hook
		if (typeof contextUsage?.contextWindow === "number") return contextUsage.contextWindow;
	} catch {
		// fall through
	}
	return safeRead(() => ctx.model?.contextWindow, undefined) ?? 0;
}

function getSessionUsage(ctx: ExtensionContext): Usage {
	try {
		const cached = getCachedSessionUsage(ctx);
		return { input: cached.input, output: cached.output, cost: cached.cost };
	} catch {
		return { input: 0, output: 0, cost: 0 };
	}
}

function defaultGitRunner(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}
