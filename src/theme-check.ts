/**
 * Theme verification card. Renders every Cathedral theme slot via Pi's `Theme`
 * accessor so a `pnpm visual` capture can prove the active Pi theme matches
 * `cathedral.json`.
 *
 * The pure rendering contract:
 * - input: a ThemeReader (a structural subset of Pi's Theme class)
 * - output: an array of strings ready to be rendered as a Component
 *
 * The component glue lives separately in `installThemeCheckCommand`.
 */

export type ThemeFgSlot =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBgSlot =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

export interface ThemeReader {
	fg(slot: ThemeFgSlot, text: string): string;
	bg(slot: ThemeBgSlot, text: string): string;
}

export const THEME_CHECK_COVERED_FG_SLOTS: readonly ThemeFgSlot[] = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
] as const;

export const THEME_CHECK_COVERED_BG_SLOTS: readonly ThemeBgSlot[] = [
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const;

function banner(theme: ThemeReader, title: string, width: number): string {
	const inner = ` ${title} `;
	const flank = Math.max(2, Math.floor((width - inner.length) / 2));
	const left = "═".repeat(flank);
	const right = "═".repeat(Math.max(0, width - left.length - inner.length));
	return theme.fg("accent", `${left}${inner}${right}`);
}

function sectionHeading(theme: ThemeReader, title: string): string {
	return theme.fg("accent", title);
}

function row(theme: ThemeReader, slot: ThemeFgSlot, label: string): string {
	return `  ${theme.fg(slot, "● ")}${theme.fg(slot, label.padEnd(20))} ${theme.fg("muted", `(${slot})`)}`;
}

function bgRow(theme: ThemeReader, slot: ThemeBgSlot, label: string): string {
	return `  ${theme.bg(slot, ` ${label.padEnd(28)} `)} ${theme.fg("muted", `(${slot})`)}`;
}

export function renderThemeCheck(theme: ThemeReader, width: number): string[] {
	const lines: string[] = [];

	lines.push(banner(theme, "CATHEDRAL THEME CHECK", width));
	lines.push("");

	lines.push(sectionHeading(theme, "STATES"));
	lines.push(row(theme, "success", "ready"));
	lines.push(row(theme, "warning", "thinking"));
	lines.push(row(theme, "border", "tool"));
	lines.push(row(theme, "error", "needs you"));
	lines.push(row(theme, "borderAccent", "learning"));
	lines.push("");

	lines.push(sectionHeading(theme, "SURFACES"));
	lines.push(`  ${theme.fg("muted", "muted text sample")} ${theme.fg("dim", "dim text sample")}`);
	lines.push(`  ${theme.fg("accent", "burnt orange focal")} ${theme.fg("borderMuted", "border muted")}`);
	lines.push(`  ${theme.fg("thinkingText", "thinking text")} ${theme.fg("toolOutput", "tool output")}`);
	lines.push("");

	lines.push(sectionHeading(theme, "MESSAGE BACKGROUNDS"));
	lines.push(bgRow(theme, "selectedBg", "selected"));
	lines.push(bgRow(theme, "userMessageBg", "user message"));
	lines.push(bgRow(theme, "customMessageBg", "custom message"));
	lines.push(bgRow(theme, "toolPendingBg", "tool pending"));
	lines.push(bgRow(theme, "toolSuccessBg", "tool success"));
	lines.push(bgRow(theme, "toolErrorBg", "tool error"));
	lines.push(`  ${theme.fg("userMessageText", "user message text")} ${theme.fg("customMessageText", "custom message text")} ${theme.fg("customMessageLabel", "[label]")}`);
	lines.push("");

	lines.push(sectionHeading(theme, "MARKDOWN"));
	lines.push(`  ${theme.fg("mdHeading", "# heading")}`);
	lines.push(`  ${theme.fg("mdLink", "link text")} ${theme.fg("mdLinkUrl", "(https://example)")} `);
	lines.push(`  ${theme.fg("mdCode", "`inline code`")} ${theme.fg("mdCodeBlock", "code block body")} ${theme.fg("mdCodeBlockBorder", "│")}`);
	lines.push(`  ${theme.fg("mdQuoteBorder", "│ ")}${theme.fg("mdQuote", "block quote")}`);
	lines.push(`  ${theme.fg("mdHr", "─".repeat(20))}`);
	lines.push(`  ${theme.fg("mdListBullet", "•")} list bullet`);
	lines.push("");

	lines.push(sectionHeading(theme, "SYNTAX"));
	lines.push(
		`  ${theme.fg("syntaxComment", "// cathedral syntax sample")}`,
	);
	lines.push(
		`  ${theme.fg("syntaxKeyword", "const")} ${theme.fg("syntaxVariable", "greeting")} ${theme.fg("syntaxOperator", "=")} ${theme.fg("syntaxString", "\"hello\"")}${theme.fg("syntaxPunctuation", ";")}`,
	);
	lines.push(
		`  ${theme.fg("syntaxKeyword", "function")} ${theme.fg("syntaxFunction", "answer")}${theme.fg("syntaxPunctuation", "()")} ${theme.fg("syntaxOperator", ":")} ${theme.fg("syntaxType", "number")} ${theme.fg("syntaxPunctuation", "{")} ${theme.fg("syntaxKeyword", "return")} ${theme.fg("syntaxNumber", "42")}${theme.fg("syntaxPunctuation", ";")} ${theme.fg("syntaxPunctuation", "}")}`,
	);
	lines.push("");

	lines.push(sectionHeading(theme, "TOOLS"));
	lines.push(
		`  ${theme.fg("toolTitle", "[bash]")} ${theme.fg("muted", "pnpm test")} ${theme.fg("success", "✓")} ${theme.fg("toolDiffAdded", "+++")} ${theme.fg("toolDiffRemoved", "---")} ${theme.fg("toolDiffContext", "context")} ${theme.fg("bashMode", "bash mode")} ${theme.fg("warning", "warn")} ${theme.fg("error", "error")}`,
	);
	lines.push("");

	lines.push(sectionHeading(theme, "THINKING RAMP"));
	lines.push(
		`  ${theme.fg("thinkingOff", "off")}  ${theme.fg("thinkingMinimal", "minimal")}  ${theme.fg("thinkingLow", "low")}  ${theme.fg("thinkingMedium", "medium")}  ${theme.fg("thinkingHigh", "high")}  ${theme.fg("thinkingXhigh", "xhigh")}`,
	);
	lines.push("");

	lines.push(theme.fg("muted", "press any key to dismiss"));

	return lines;
}
