import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { createPiTuiSurface, type PiTuiSurface } from "opentui-island/pi-tui";
import {
	formatCwd,
	formatTokenCount,
	resolveGitBranch,
	type ThinkingLevel,
} from "./footer.js";
import {
	SUMOCODE_QUOTE,
	SUMOCODE_QUOTE_ATTRIBUTION,
	SUMOCODE_WORDMARK,
} from "./splash.js";
import { CATHEDRAL_TOKENS, type SumoCodeState } from "./tokens.js";
import { VOICE } from "./voice.js";

const SHELL_ISLAND_MODULE_URL = new URL("./opentui/cathedral-shell.island.tsx", import.meta.url);
const FOOTER_ISLAND_MODULE_URL = new URL("./opentui/cathedral-footer.island.tsx", import.meta.url);

type IslandProps = Record<string, string | number | boolean | string[]>;

type Usage = {
	input: number;
	output: number;
	cost: number;
};

function padToWidth(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	} catch {
		return false;
	}
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

function getThinkingLevel(ctx: ExtensionContext): ThinkingLevel {
	return (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel ?? "medium";
}

function footerProps(ctx: ExtensionContext, branch: string | null, state: SumoCodeState): IslandProps {
	const usage = getSessionUsage(ctx);
	const path = `${formatCwd(ctx.cwd)}${branch ? ` (${branch})` : ""}`;
	return {
		left: `${VOICE.status[state]} · ${ctx.model?.id ?? "no-model"} · ${getThinkingLevel(ctx)}`,
		right: `${path} · ↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)} · $${usage.cost.toFixed(2)}`,
		stateColor: CATHEDRAL_TOKENS.colors.states[state],
		foreground: CATHEDRAL_TOKENS.colors.foreground,
		foregroundDim: CATHEDRAL_TOKENS.colors.foregroundDim,
		background: CATHEDRAL_TOKENS.colors.background,
	};
}

function shellProps(ctx: ExtensionContext, state: SumoCodeState): IslandProps {
	const id = ctx.sessionManager.getSessionId();
	const label = ctx.sessionManager.getSessionName() ?? id.split("-")[0] ?? "session";
	return {
		brand: "SUMOCODE",
		activeLabel: VOICE.status[state],
		stateColor: CATHEDRAL_TOKENS.colors.states[state],
		accent: CATHEDRAL_TOKENS.colors.accent,
		foreground: CATHEDRAL_TOKENS.colors.foreground,
		foregroundDim: CATHEDRAL_TOKENS.colors.foregroundDim,
		divider: CATHEDRAL_TOKENS.colors.divider,
		quote: SUMOCODE_QUOTE,
		quoteAttribution: SUMOCODE_QUOTE_ATTRIBUTION,
		hasMessages: sessionHasMessages(ctx),
		wordmarkRows: [...SUMOCODE_WORDMARK],
		activeSessionLabel: label,
	};
}

class OpenTuiIslandComponent implements Component {
	private surface: PiTuiSurface | null = null;
	private initializing = false;
	private error: string | null = null;
	private lastHeight = 0;
	private lastPropsKey = "";
	private generation = 0;

	constructor(
		private readonly tui: TUI,
		private readonly title: string,
		private readonly moduleUrl: URL,
		private readonly getHeight: () => number,
		private readonly getProps: () => IslandProps,
	) {}

	invalidate(): void {
		this.surface?.invalidate();
	}

	dispose(): void {
		this.generation += 1;
		void this.surface?.destroy();
		this.surface = null;
	}

	render(width: number): string[] {
		const height = Math.max(1, this.getHeight());
		const props = this.getProps();
		const propsKey = JSON.stringify(props);

		if (!this.surface || height !== this.lastHeight) {
			this.start(width, height, props, propsKey);
		} else if (propsKey !== this.lastPropsKey) {
			this.lastPropsKey = propsKey;
			void this.surface
				.updateProps(props)
				.catch((error: unknown) => {
					this.error = formatError(error);
					this.tui.requestRender();
				});
		}

		if (this.error) {
			return [padToWidth(`${this.title} failed: ${this.error}`, width), ...this.blank(width, height - 1)];
		}

		if (!this.surface) {
			return [padToWidth(`${this.title}: starting Bun sidecar…`, width), ...this.blank(width, height - 1)];
		}

		return this.surface.render(width);
	}

	private blank(width: number, count: number): string[] {
		return Array.from({ length: Math.max(0, count) }, () => " ".repeat(Math.max(1, width)));
	}

	private start(width: number, height: number, props: IslandProps, propsKey: string): void {
		if (this.initializing) return;
		this.initializing = true;
		this.error = null;
		this.lastHeight = height;
		this.lastPropsKey = propsKey;
		const generation = ++this.generation;
		const previous = this.surface;
		this.surface = null;

		void (async () => {
			try {
				await previous?.destroy();
				const surface = await createPiTuiSurface({
					height,
					initialWidth: Math.max(1, width),
					requestRender: () => this.tui.requestRender(),
					island: { module: this.moduleUrl, props },
				});
				if (generation !== this.generation) {
					await surface.destroy();
					return;
				}
				this.surface = surface;
				await surface.sync(Math.max(1, width));
			} catch (error) {
				if (generation === this.generation) this.error = formatError(error);
			} finally {
				if (generation === this.generation) this.initializing = false;
				this.tui.requestRender();
			}
		})();
	}
}

/**
 * Spike extension: deliberately minimal, no altscreen, no custom editor wrapping.
 * Run with:
 *   pi -e ./src/opentui-spike-extension.ts
 */
export default function openTuiCathedralSpike(pi: ExtensionAPI): void {
	let state: SumoCodeState = "idle";
	let requestRender: (() => void) | undefined;

	const setState = (next: SumoCodeState): void => {
		state = next;
		requestRender?.();
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((tui) => {
			requestRender = () => tui.requestRender();
			// Clear the launch command once without entering altscreen. This keeps
			// ordinary terminal scrollback/mouse behavior while giving the spike a
			// clean viewport for the first frame.
			process.nextTick(() => tui.requestRender(true));
			return new OpenTuiIslandComponent(
				tui,
				"cathedral shell island",
				SHELL_ISLAND_MODULE_URL,
				() => {
					// Pi's header container keeps one spacer above + below the custom header.
					// Below it, startup splash has: widgetAbove spacer (1), default editor (~3), footer (1).
					// The island fills the remaining rows so the footer's one-line island lands
					// on the last terminal row in the empty-state prototype.
					const terminalRows = tui.terminal.rows || process.stdout.rows || 40;
					return sessionHasMessages(ctx) ? 1 : Math.max(8, terminalRows - 7);
				},
				() => shellProps(ctx, state),
			);
		});

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return new (class SpikeFooter extends OpenTuiIslandComponent {
				override dispose(): void {
					unsubscribe();
					super.dispose();
				}
			})(
				tui,
				"cathedral footer island",
				FOOTER_ISLAND_MODULE_URL,
				() => 1,
				() => footerProps(ctx, footerData.getGitBranch() ?? resolveGitBranch(ctx.cwd), state),
			);
		});
	});

	pi.on("before_agent_start", () => setState("thinking"));
	pi.on("agent_start", () => setState("thinking"));
	pi.on("tool_call", () => setState("tool"));
	pi.on("tool_result", () => setState("thinking"));
	pi.on("agent_end", () => setState("idle"));
	pi.on("message_start", () => requestRender?.());
	pi.on("message_end", () => requestRender?.());
}
