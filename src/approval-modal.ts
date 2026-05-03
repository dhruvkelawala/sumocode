/**
 * Cathedral approval modal (Element 6 from CATHEDRAL_DECISIONS.md).
 *
 * Visual:
 *
 *                                 APPROVAL REQUIRED
 *   ─────────────────────────────────────────────────────────────────────
 *
 *   You are about to execute:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ rm -rf node_modules/                        │
 *   └─────────────────────────────────────────────┘
 *
 *   — This will remove 234MB and is irreversible.
 *
 *   ─────────────────────────────────────────────────────────────────────
 *   ■ SYSTEM NOTICE                              [Y]ES  [N]O  [A]LWAYS
 *
 * Approach: instead of re-registering bash/edit/write (which would mean
 * re-implementing Pi's tool execution), we intercept the `tool_call` event
 * for destructive tools, show our cathedral modal, and let Pi proceed only
 * if the user picks YES or ALWAYS. NO blocks the call.
 *
 * Pi's existing allowlist (set via Pi's own approval flow) still applies
 * — we only invoke our modal when Pi would otherwise prompt. ALWAYS routes
 * to Pi's allowlist mechanism if we can detect it; otherwise stores in our
 * own ~/.sumocode/allowlist.json (v1 fallback).
 */

import type { Component } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS } from "./tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const PANEL_INDENT = "   ";
const BIBLE_COMMAND_BOX_WIDTH_AT_80 = 68;

function visibleLength(text: string): number {
	return visibleWidth(text.replace(ANSI_PATTERN, ""));
}

function sgr(hex: string, mode: 38 | 48): string {
	const normalized = hex.replace("#", "");
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return `\u001b[${mode};2;${red};${green};${blue}m`;
}

function fg(text: string, hex: string): string {
	return `${sgr(hex, 38)}${text}${RESET}`;
}

function persistentBg(text: string, fgHex: string, bgHex: string): string {
	const styleCode = `${sgr(fgHex, 38)}${sgr(bgHex, 48)}`;
	return `${styleCode}${text.replace(/\u001b\[0m/g, `${RESET}${styleCode}`)}${RESET}`;
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleLength(line) > width ? truncateToWidth(line, width, "…") : line;
}

function padRight(line: string, width: number): string {
	const fitted = fitLine(line, width);
	const length = visibleLength(fitted);
	if (length >= width) return fitted;
	return `${fitted}${" ".repeat(width - length)}`;
}

function center(line: string, width: number): string {
	const fitted = fitLine(line, width);
	const length = visibleLength(fitted);
	if (length >= width) return fitted;
	const left = Math.floor((width - length) / 2);
	return `${" ".repeat(left)}${fitted}${" ".repeat(width - length - left)}`;
}

function panelRow(inner: string, width: number): string {
	return persistentBg(padRight(inner, width), CATHEDRAL_TOKENS.colors.foreground, CATHEDRAL_TOKENS.colors.surfaceLifted);
}

function splitRule(width: number): string {
	const ruleLength = Math.max(1, Math.min(22, Math.floor((width - 5) / 2)));
	const divider = CATHEDRAL_TOKENS.colors.divider;
	return center(`${fg("─".repeat(ruleLength), divider)}  ${fg("·", divider)}  ${fg("─".repeat(ruleLength), divider)}`, width);
}

export type ApprovalChoice = "yes" | "no" | "always";

export type ApprovalModalSnapshot = {
	command: string;
	descriptionLines: string[];
	activeButton: ApprovalChoice;
};

const DEFAULT_BUTTON_ORDER: readonly ApprovalChoice[] = ["yes", "no", "always"];

function renderButton(choice: ApprovalChoice, isActive: boolean): string {
	const key = choice === "yes" ? "Y" : choice === "no" ? "N" : "A";
	const rest = choice === "yes" ? "ES" : choice === "no" ? "O" : "LWAYS";
	if (isActive) {
		const label = choice === "yes" ? " YES " : choice === "no" ? "  NO  " : " ALWAYS ";
		return `${sgr(CATHEDRAL_TOKENS.colors.states.approval, 48)}${sgr(CATHEDRAL_TOKENS.colors.background, 38)}${label}${RESET}`;
	}
	return `${fg("[", CATHEDRAL_TOKENS.colors.divider)}${fg(key, CATHEDRAL_TOKENS.colors.foreground)}${fg("]", CATHEDRAL_TOKENS.colors.divider)}${fg(rest, CATHEDRAL_TOKENS.colors.foreground)}`;
}

function commandBoxWidth(width: number): number {
	const maxBoxWidth = Math.max(2, width - visibleLength(PANEL_INDENT));
	const target = Math.max(20, width - (80 - BIBLE_COMMAND_BOX_WIDTH_AT_80));
	return Math.min(maxBoxWidth, target);
}

function renderCommandFrame(command: string, width: number): string[] {
	const boxWidth = commandBoxWidth(width);
	const innerWidth = Math.max(0, boxWidth - 2);
	const commandWidth = Math.max(1, innerWidth - 2);
	const border = CATHEDRAL_TOKENS.colors.divider;
	const commandRows = wrapTextWithAnsi(command, commandWidth);
	const safeRows = commandRows.length > 0 ? commandRows : [""];
	const boxRows = [
		fg(`┌${"─".repeat(innerWidth)}┐`, border),
		...safeRows.map((row) => `${fg("│", border)} ${fg(fitLine(row, commandWidth), CATHEDRAL_TOKENS.colors.foreground)}${" ".repeat(Math.max(0, commandWidth - visibleLength(row)))} ${fg("│", border)}`),
		fg(`└${"─".repeat(innerWidth)}┘`, border),
	];
	return boxRows.map((row) => `${PANEL_INDENT}${persistentBg(padRight(row, boxWidth), CATHEDRAL_TOKENS.colors.foreground, CATHEDRAL_TOKENS.colors.surfaceRecess)}`);
}

function renderDescriptionRows(descriptionLines: readonly string[], width: number): string[] {
	const rows: string[] = [];
	const contentWidth = Math.max(1, width - visibleLength(PANEL_INDENT));
	for (let index = 0; index < descriptionLines.length; index += 1) {
		const prefix = index === 0 ? "— " : "  ";
		const wrapped = wrapTextWithAnsi(descriptionLines[index] ?? "", Math.max(1, contentWidth - visibleLength(prefix)));
		const lines = wrapped.length > 0 ? wrapped : [""];
		for (let rowIndex = 0; rowIndex < lines.length; rowIndex += 1) {
			const rowPrefix = rowIndex === 0 ? prefix : "  ";
			rows.push(`${PANEL_INDENT}${fg(`${rowPrefix}${lines[rowIndex]}`, CATHEDRAL_TOKENS.colors.foregroundDim)}`);
		}
	}
	return rows;
}

/**
 * Pure render of the modal content (lines that go inside the overlay).
 */
export function renderApprovalModal(snapshot: ApprovalModalSnapshot, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];

	lines.push(panelRow("", safeWidth));
	lines.push(panelRow(center(`${fg("✾", CATHEDRAL_TOKENS.colors.states.approval)}  ${fg("APPROVAL REQUIRED", CATHEDRAL_TOKENS.colors.states.approval)}  ${fg("✾", CATHEDRAL_TOKENS.colors.states.approval)}`, safeWidth), safeWidth));
	lines.push(panelRow("", safeWidth));
	lines.push(panelRow(splitRule(safeWidth), safeWidth));
	lines.push(panelRow("", safeWidth));

	lines.push(panelRow(`${PANEL_INDENT}${fg("You are about to execute:", CATHEDRAL_TOKENS.colors.foreground)}`, safeWidth));
	lines.push(panelRow("", safeWidth));

	for (const row of renderCommandFrame(snapshot.command, safeWidth)) lines.push(panelRow(row, safeWidth));
	lines.push(panelRow("", safeWidth));

	for (const row of renderDescriptionRows(snapshot.descriptionLines, safeWidth)) lines.push(panelRow(row, safeWidth));

	lines.push(panelRow("", safeWidth));
	lines.push(panelRow(splitRule(safeWidth), safeWidth));
	lines.push(panelRow("", safeWidth));

	const systemNotice = `${fg("■", CATHEDRAL_TOKENS.colors.states.approval)} ${fg("SYSTEM NOTICE", CATHEDRAL_TOKENS.colors.foregroundDim)}`;
	const buttons = DEFAULT_BUTTON_ORDER.map((choice) => renderButton(choice, choice === snapshot.activeButton)).join("  ");
	const left = `${PANEL_INDENT}${systemNotice}`;
	const right = `${buttons}${PANEL_INDENT}`;
	const gap = Math.max(1, safeWidth - visibleLength(left) - visibleLength(right));
	lines.push(panelRow(`${left}${" ".repeat(gap)}${right}`, safeWidth));
	lines.push(panelRow("", safeWidth));

	return lines;
}

// ============================================================================
// State machine
// ============================================================================

export type ApprovalInputResult = {
	snapshot: ApprovalModalSnapshot;
	done?: ApprovalChoice;
};

function nextButton(active: ApprovalChoice, direction: 1 | -1): ApprovalChoice {
	const order = DEFAULT_BUTTON_ORDER;
	const idx = order.indexOf(active);
	const next = (idx + direction + order.length) % order.length;
	return order[next]!;
}

/**
 * Pure state transition. Accepts a key data string OR Key.<id> string for
 * test convenience. Returns the new snapshot + optional `done` result.
 */
export function updateApprovalSnapshot(
	snapshot: ApprovalModalSnapshot,
	data: string,
): ApprovalInputResult {
	// Direct letter selection — Y/N/A
	const lower = data.toLowerCase();
	if (lower === "y") return { snapshot: { ...snapshot, activeButton: "yes" }, done: "yes" };
	if (lower === "n") return { snapshot: { ...snapshot, activeButton: "no" }, done: "no" };
	if (lower === "a") return { snapshot: { ...snapshot, activeButton: "always" }, done: "always" };

	// Tab cycles forward, Shift+Tab cycles backward
	if (data === "tab" || matchesKey(data, "tab")) {
		return { snapshot: { ...snapshot, activeButton: nextButton(snapshot.activeButton, 1) } };
	}
	if (data === "shift+tab" || matchesKey(data, "shift+tab")) {
		return { snapshot: { ...snapshot, activeButton: nextButton(snapshot.activeButton, -1) } };
	}

	// Arrow keys also cycle
	if (data === "right" || matchesKey(data, "right") || data === "down" || matchesKey(data, "down")) {
		return { snapshot: { ...snapshot, activeButton: nextButton(snapshot.activeButton, 1) } };
	}
	if (data === "left" || matchesKey(data, "left") || data === "up" || matchesKey(data, "up")) {
		return { snapshot: { ...snapshot, activeButton: nextButton(snapshot.activeButton, -1) } };
	}

	// Enter selects the active button
	if (data === "enter" || matchesKey(data, "enter") || data === "return" || matchesKey(data, "return")) {
		return { snapshot, done: snapshot.activeButton };
	}

	// Escape rejects (returns "no" for safety)
	if (data === "escape" || matchesKey(data, "escape")) {
		return { snapshot: { ...snapshot, activeButton: "no" }, done: "no" };
	}

	return { snapshot };
}

// ============================================================================
// Pi-glue (Component + showApprovalModal)
// ============================================================================

class ApprovalModalComponent implements Component {
	constructor(
		private snapshot: ApprovalModalSnapshot,
		private readonly done: (choice: ApprovalChoice) => void,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const result = updateApprovalSnapshot(this.snapshot, data);
		this.snapshot = result.snapshot;
		if (result.done) this.done(result.done);
	}

	render(width: number): string[] {
		return renderApprovalModal(this.snapshot, width);
	}
}

/**
 * Open the approval modal as a centered overlay. Resolves to the user's
 * choice. Default focus is `[N]O` for safety.
 */
export async function showApprovalModal(
	ctx: ExtensionContext,
	snapshot: Omit<ApprovalModalSnapshot, "activeButton">,
): Promise<ApprovalChoice> {
	const fullSnapshot: ApprovalModalSnapshot = { ...snapshot, activeButton: "no" };

	return ctx.ui.custom<ApprovalChoice>(
		(_tui, _theme, _kb, done: (result: ApprovalChoice) => void) =>
			new ApprovalModalComponent(fullSnapshot, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "60%",
				minWidth: 50,
				maxHeight: "80%",
			},
		},
	);
}

// ============================================================================
// tool_call interception
// ============================================================================

// ============================================================================
// Dangerous command detection — configurable
// ============================================================================

export interface ApprovalGateConfig {
	/** Regex patterns for dangerous bash commands. */
	readonly dangerousPatterns: readonly RegExp[];
	/** Regex patterns for mutating gh CLI commands. */
	readonly ghMutatingPatterns: readonly RegExp[];
	/** Extra user-supplied patterns (appended to dangerous). */
	readonly extraPatterns: readonly RegExp[];
	/** Commands to always allow (bypass all patterns). */
	readonly allowList: readonly RegExp[];
}

const DEFAULT_DANGEROUS_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[\w]*r[\w]*|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bmkfs\b/i,
	/\bdd\b.*\bof=/i,
	/\b(shutdown|reboot|halt|poweroff)\b/i,
	/\bgit\s+push\b.*--force(?!-with-lease)/i,
	/\bgit\s+(reset\s+--hard|clean\s+-fd)/i,
];

const DEFAULT_GH_MUTATING_PATTERNS: readonly RegExp[] = [
	/\bgh\s+pr\s+(create|merge|close|edit|ready|review)\b/i,
	/\bgh\s+issue\s+(create|close|edit|delete|transfer|pin)\b/i,
	/\bgh\s+release\s+(create|delete|edit)\b/i,
	/\bgh\s+repo\s+(create|delete|fork|rename|archive)\b/i,
	/\bgh\s+api\b.*(-X\s+(POST|PUT|PATCH|DELETE)|--method\s+(POST|PUT|PATCH|DELETE))/i,
];

export const DEFAULT_APPROVAL_CONFIG: ApprovalGateConfig = {
	dangerousPatterns: DEFAULT_DANGEROUS_PATTERNS,
	ghMutatingPatterns: DEFAULT_GH_MUTATING_PATTERNS,
	extraPatterns: [],
	allowList: [],
};

let activeConfig: ApprovalGateConfig = DEFAULT_APPROVAL_CONFIG;

export function setApprovalConfig(config: Partial<ApprovalGateConfig>): void {
	activeConfig = { ...DEFAULT_APPROVAL_CONFIG, ...config };
}

export function getApprovalConfig(): ApprovalGateConfig {
	return activeConfig;
}

export function isDangerousBashCommand(command: string): boolean {
	if (activeConfig.allowList.some((p) => p.test(command))) return false;
	return activeConfig.dangerousPatterns.some((p) => p.test(command))
		|| activeConfig.ghMutatingPatterns.some((p) => p.test(command))
		|| activeConfig.extraPatterns.some((p) => p.test(command));
}

/**
 * Sumo-side session allow set, populated by `[A]lways` selections.
 * Cleared on extension reload. Keyed by command string.
 */
const sessionAllowSet = new Set<string>();

function describeCommand(command: string): { command: string; description: string[] } {
	if (activeConfig.ghMutatingPatterns.some((p) => p.test(command))) {
		return { command, description: ["This GitHub CLI command will modify remote state."] };
	}
	if (/\brm\b/.test(command)) {
		return { command, description: ["This will permanently delete files."] };
	}
	if (/\bsudo\b/.test(command)) {
		return { command, description: ["This runs with elevated privileges."] };
	}
	if (/\bgit\s+push.*--force/.test(command)) {
		return { command, description: ["Force push rewrites remote history."] };
	}
	if (/\bgit\s+reset\s+--hard/.test(command)) {
		return { command, description: ["Hard reset discards uncommitted changes."] };
	}
	return { command, description: ["The agent wants to execute a potentially dangerous command."] };
}

/**
 * Install the approval gate. Only intercepts bash tool calls with dangerous
 * command patterns. Does NOT gate edit/write/read — matching vanilla Pi
 * behavior where regular file operations proceed without approval.
 *
 * Gated commands:
 *   - rm -rf / rm --recursive
 *   - sudo
 *   - chmod/chown 777
 *   - git push --force (without --force-with-lease)
 *   - git reset --hard / git clean -fd
 *   - gh pr create/merge/close, gh issue create/close/delete, etc.
 *
 * NOT gated:
 *   - edit, write, read (regular agent iteration)
 *   - gh pr list, gh issue view (read-only gh commands)
 *   - pnpm/npm/node (build commands)
 *   - git add/commit/push (normal git)
 */
export function installApprovalGate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.toolName !== "bash") return;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!isDangerousBashCommand(command)) return;
		if (sessionAllowSet.has(command)) return;

		const info = describeCommand(command);
		let choice: ApprovalChoice = "no";
		try {
			choice = await showApprovalModal(ctx, { command: info.command, descriptionLines: info.description });
		} catch {
			choice = "no";
		}

		if (choice === "always") {
			sessionAllowSet.add(command);
		}
		if (choice === "no") {
			return { block: true, reason: "user denied via cathedral approval modal" };
		}
		return undefined;
	});
}
