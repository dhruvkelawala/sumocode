import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { activeThemeColors, getActiveTheme, getTheme, listThemes } from "../themes/index.js";
import { emitCathedralThemeChanged } from "../sumo-tui/cathedral/theme-bridge.js";

export const THEME_RESULT_CUSTOM_TYPE = "sumocode-theme-result";

export interface ThemeResultDetails {
	readonly tone: "info" | "warning";
	readonly lines: readonly string[];
}

function isThemeResultDetails(details: unknown): details is ThemeResultDetails {
	if (typeof details !== "object" || details === null) return false;
	const record = details as { tone?: unknown; lines?: unknown };
	return (record.tone === "info" || record.tone === "warning") && Array.isArray(record.lines)
		&& record.lines.every((line) => typeof line === "string");
}

function rgbAnsi(hex: string, channel: 38 | 48): string {
	const n = hex.replace("#", "");
	const r = Number.parseInt(n.slice(0, 2), 16);
	const g = Number.parseInt(n.slice(2, 4), 16);
	const b = Number.parseInt(n.slice(4, 6), 16);
	return `\u001b[${channel};2;${r};${g};${b}m`;
}

function styleLine(line: string, hex: string): string {
	return `${rgbAnsi(hex, 38)}${line}\u001b[0m`;
}

function renderThemeResultLines(details: ThemeResultDetails, width: number): string[] {
	const colors = activeThemeColors();
	const accent = details.tone === "warning" ? colors.states.approval : colors.accent;
	const fg = colors.foreground;
	const dim = colors.foregroundDim;
	const safeWidth = Math.max(8, width);

	const label = details.tone === "warning" ? "/sumo:theme · failed" : "/sumo:theme";
	const headPrefix = "┌─ ";
	const headInnerWidth = Math.max(0, safeWidth - visibleWidth(headPrefix) - 1);
	const headLabel = truncateToWidth(label, headInnerWidth, "…");
	const headRule = "─".repeat(Math.max(0, safeWidth - visibleWidth(headPrefix) - visibleWidth(headLabel) - 1));
	const out: string[] = [];
	out.push(`${styleLine(headPrefix, dim)}${styleLine(headLabel, accent)} ${styleLine(headRule, dim)}`);

	const bodyPrefix = "│ ";
	const bodyInnerWidth = Math.max(0, safeWidth - visibleWidth(bodyPrefix));
	for (const raw of details.lines) {
		const clipped = truncateToWidth(raw, bodyInnerWidth, "…");
		out.push(`${styleLine(bodyPrefix, dim)}${styleLine(clipped, fg)}`);
	}

	const tailRule = "─".repeat(Math.max(0, safeWidth - 1));
	out.push(`${styleLine("└", dim)}${styleLine(tailRule, dim)}`);
	return out;
}

class ThemeResultComponent implements Component {
	public constructor(private readonly details: ThemeResultDetails) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		return renderThemeResultLines(this.details, width);
	}
}

export function registerThemeResultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(THEME_RESULT_CUSTOM_TYPE, (message) => {
		if (!isThemeResultDetails(message.details)) return undefined;
		return new ThemeResultComponent(message.details);
	});
}

function pushThemeResult(pi: ExtensionAPI, ctx: ExtensionContext, lines: string[], tone: "info" | "warning"): void {
	if (ctx.hasUI) {
		pi.sendMessage(
			{
				customType: THEME_RESULT_CUSTOM_TYPE,
				content: lines.join("\n"),
				display: true,
				details: { tone, lines } satisfies ThemeResultDetails,
			},
			{ triggerTurn: false },
		);
		ctx.ui.notify(lines[0] ?? "", tone);
		return;
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

export function formatActiveThemeMessage(): string {
	const theme = getActiveTheme();
	return `theme: ${theme.name} — ${theme.description}`;
}

export function formatThemeList(): string[] {
	const active = getActiveTheme().name;
	return listThemes().map((theme) => `${theme.name === active ? "*" : " "} ${theme.name} — ${theme.description}`);
}

/** Register `/sumo:theme [list|name]` for SumoCode theme switching. */
export function registerThemeCommand(pi: ExtensionAPI): void {
	registerThemeResultRenderer(pi);
	pi.registerCommand("sumo:theme", {
		description: "Show or switch the active SumoCode theme",
		handler: async (args: string, ctx: ExtensionContext) => {
			const requested = args.trim();
			if (!requested) {
				pushThemeResult(pi, ctx, [formatActiveThemeMessage()], "info");
				return;
			}

			if (requested.toLowerCase() === "list") {
				pushThemeResult(pi, ctx, formatThemeList(), "info");
				return;
			}

			const theme = getTheme(requested);
			if (!theme) {
				pushThemeResult(pi, ctx, [`Unknown SumoCode theme: ${requested}`], "warning");
				return;
			}

			if (ctx.hasUI) {
				const result = ctx.ui.setTheme(theme.name);
				if (!result.success) {
					pushThemeResult(pi, ctx, [`theme failed: ${result.error ?? theme.name}`], "warning");
					return;
				}
			}

			emitCathedralThemeChanged(theme.name);
			pushThemeResult(pi, ctx, [`theme set: ${theme.name}`], "info");
		},
	});
}
