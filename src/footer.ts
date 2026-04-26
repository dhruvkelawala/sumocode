import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
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
	contextPercent: number | null;
	contextWindow: number;
	state: SumoCodeState;
	modelId: string;
};

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

export function formatContextGauge(contextPercent: number | null, contextWindow: number): string {
	const window = formatTokenCount(contextWindow);
	if (contextPercent === null || !Number.isFinite(contextPercent)) return `?/${window}`;
	return `${Math.round(contextPercent)}%/${window}`;
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

export function formatFooterLine(snapshot: FooterSnapshot, width = 120): string {
	const branch = snapshot.branch ? ` (${snapshot.branch})` : "";
	const path = colorHex(`${formatCwd(snapshot.cwd)}${branch}`, CATHEDRAL_TOKENS.colors.foreground);
	const tokens = colorHex(
		`↑${formatTokenCount(snapshot.inputTokens)} ↓${formatTokenCount(snapshot.outputTokens)}`,
		CATHEDRAL_TOKENS.colors.foregroundDim,
	);
	const cost = colorHex(`$${snapshot.costUsd.toFixed(2)}`, CATHEDRAL_TOKENS.colors.foregroundDim);
	const gauge = colorHex(
		formatContextGauge(snapshot.contextPercent, snapshot.contextWindow),
		CATHEDRAL_TOKENS.colors.foregroundDim,
	);
	const dot = colorHex("●", CATHEDRAL_TOKENS.colors.states[snapshot.state]);
	const stateLabel = colorHex(VOICE.status[snapshot.state], CATHEDRAL_TOKENS.colors.foreground);
	const model = colorHex(snapshot.modelId, CATHEDRAL_TOKENS.colors.foregroundDim);
	const sep = colorHex(" · ", CATHEDRAL_TOKENS.colors.divider);

	const line = [path, tokens, cost, gauge, `${dot} ${stateLabel}`, model].join(sep);
	return truncateToWidth(line, width);
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
	const contextUsage = ctx.getContextUsage() ?? null;
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercent = contextUsage?.percent ?? null;

	return {
		cwd: ctx.cwd,
		branch,
		inputTokens: usage.input,
		outputTokens: usage.output,
		costUsd: usage.cost,
		contextPercent,
		contextWindow,
		state,
		modelId: ctx.model?.id ?? "no-model",
	};
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
