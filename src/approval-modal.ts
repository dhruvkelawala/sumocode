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

import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { activeThemeColors } from "./themes/index.js";
import {
	RESET,
	center,
	fg,
	fitLine,
	padRight,
	persistentBg,
	sgr,
	splitRule,
	visibleLength,
	wrapPanelRow,
} from "./cathedral/scriptorium-chrome.js";

const PANEL_INDENT = "   ";
const BIBLE_COMMAND_BOX_WIDTH_AT_80 = 68;
/**
 * Cap the visible row count of the command box. Long bash commands (e.g.
 * a deeply piped one-liner) would otherwise wrap into dozens of rows and
 * grow the modal beyond the terminal height. The remaining rows are
 * collapsed into a `… N more lines` indicator so the user still sees that
 * the command is truncated and can `⎘` to abort and copy from session.
 */
const MAX_COMMAND_ROWS = 12;
const MAX_DESCRIPTION_ROWS = 4;

const panelRow = wrapPanelRow;

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
		return `${sgr(activeThemeColors().states.approval, 48)}${sgr(activeThemeColors().background, 38)}${label}${RESET}`;
	}
	return `${fg("[", activeThemeColors().divider)}${fg(key, activeThemeColors().foreground)}${fg("]", activeThemeColors().divider)}${fg(rest, activeThemeColors().foreground)}`;
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
	const border = activeThemeColors().divider;
	const dim = activeThemeColors().foregroundDim;
	const wrappedRows = wrapTextWithAnsi(command, commandWidth);
	const initialRows = wrappedRows.length > 0 ? wrappedRows : [""];
	const overflowCount = Math.max(0, initialRows.length - MAX_COMMAND_ROWS);
	const commandRows = overflowCount > 0
		? [
			...initialRows.slice(0, MAX_COMMAND_ROWS - 1),
			fitLine(`… ${overflowCount + 1} more lines hidden`, commandWidth),
		]
		: initialRows;
	const commandFg = (row: string, isOverflow: boolean): string =>
		fg(fitLine(row, commandWidth), isOverflow ? dim : activeThemeColors().foreground);
	const boxRows = [
		fg(`┌${"─".repeat(innerWidth)}┐`, border),
		...commandRows.map((row, index) => {
			const isOverflow = overflowCount > 0 && index === commandRows.length - 1;
			const paddingCount = Math.max(0, commandWidth - visibleLength(row));
			return `${fg("│", border)} ${commandFg(row, isOverflow)}${" ".repeat(paddingCount)} ${fg("│", border)}`;
		}),
		fg(`└${"─".repeat(innerWidth)}┘`, border),
	];
	return boxRows.map((row) => `${PANEL_INDENT}${persistentBg(padRight(row, boxWidth), activeThemeColors().foreground, activeThemeColors().surfaceRecess)}`);
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
			rows.push(`${PANEL_INDENT}${fg(`${rowPrefix}${lines[rowIndex]}`, activeThemeColors().foregroundDim)}`);
		}
	}
	if (rows.length <= MAX_DESCRIPTION_ROWS) return rows;
	const hidden = rows.length - (MAX_DESCRIPTION_ROWS - 1);
	return [
		...rows.slice(0, MAX_DESCRIPTION_ROWS - 1),
		`${PANEL_INDENT}${fg(`  … ${hidden} more lines hidden`, activeThemeColors().foregroundDim)}`,
	];
}

/**
 * Pure render of the modal content (lines that go inside the overlay).
 */
export function renderApprovalModal(snapshot: ApprovalModalSnapshot, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];

	lines.push(panelRow("", safeWidth));
	lines.push(panelRow(center(`${fg("✾", activeThemeColors().states.approval)}  ${fg("APPROVAL REQUIRED", activeThemeColors().states.approval)}  ${fg("✾", activeThemeColors().states.approval)}`, safeWidth), safeWidth));
	lines.push(panelRow("", safeWidth));
	lines.push(panelRow(splitRule(safeWidth), safeWidth));
	lines.push(panelRow("", safeWidth));

	lines.push(panelRow(`${PANEL_INDENT}${fg("You are about to execute:", activeThemeColors().foreground)}`, safeWidth));
	lines.push(panelRow("", safeWidth));

	for (const row of renderCommandFrame(snapshot.command, safeWidth)) lines.push(panelRow(row, safeWidth));
	lines.push(panelRow("", safeWidth));

	for (const row of renderDescriptionRows(snapshot.descriptionLines, safeWidth)) lines.push(panelRow(row, safeWidth));

	lines.push(panelRow("", safeWidth));
	lines.push(panelRow(splitRule(safeWidth), safeWidth));
	lines.push(panelRow("", safeWidth));

	const systemNotice = `${fg("■", activeThemeColors().states.approval)} ${fg("SYSTEM NOTICE", activeThemeColors().foregroundDim)}`;
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
