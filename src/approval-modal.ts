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
import { matchesKey } from "@mariozechner/pi-tui";
import { colorHex } from "./footer.js";
import { CATHEDRAL_TOKENS } from "./tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function center(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	const pad = Math.floor((width - len) / 2);
	return `${" ".repeat(pad)}${line}`;
}

function divider(width: number): string {
	const inner = Math.max(0, width - 6);
	return `   ${colorHex("─".repeat(inner), CATHEDRAL_TOKENS.colors.divider)}`;
}

export type ApprovalChoice = "yes" | "no" | "always";

export type ApprovalModalSnapshot = {
	command: string;
	descriptionLines: string[];
	activeButton: ApprovalChoice;
};

const DEFAULT_BUTTON_ORDER: readonly ApprovalChoice[] = ["yes", "no", "always"];

function renderButton(choice: ApprovalChoice, isActive: boolean): string {
	const label = choice === "yes" ? "[Y]ES" : choice === "no" ? "[N]O" : "[A]LWAYS";
	if (isActive) {
		// Active button is filled in accent (burnt orange) per Q6.4 lock
		const bg = `\u001b[48;2;217;119;6m`;
		const fg = `\u001b[38;2;26;21;17m`; // background hex 1A1511 inverted on accent
		return `${bg}${fg} ${label} ${RESET}`;
	}
	return ` ${colorHex(label, CATHEDRAL_TOKENS.colors.foreground)} `;
}

/**
 * Pure render of the modal content (lines that go inside the overlay).
 */
export function renderApprovalModal(snapshot: ApprovalModalSnapshot, width: number): string[] {
	const lines: string[] = [];

	lines.push("");
	lines.push(center(colorHex("APPROVAL REQUIRED", CATHEDRAL_TOKENS.colors.accent), width));
	lines.push(divider(width));
	lines.push("");

	// "You are about to execute:"
	lines.push(`   ${colorHex("You are about to execute:", CATHEDRAL_TOKENS.colors.foreground)}`);
	lines.push("");

	// Code block frame around the command
	const innerWidth = Math.max(20, width - 6);
	const top = colorHex(`┌${"─".repeat(innerWidth - 2)}┐`, CATHEDRAL_TOKENS.colors.divider);
	const bottom = colorHex(`└${"─".repeat(innerWidth - 2)}┘`, CATHEDRAL_TOKENS.colors.divider);
	const sideOpen = colorHex("│", CATHEDRAL_TOKENS.colors.divider);
	const sideClose = colorHex("│", CATHEDRAL_TOKENS.colors.divider);
	const cmdText = colorHex(snapshot.command, CATHEDRAL_TOKENS.colors.accent);
	const cmdLine = `${sideOpen} ${cmdText}`;
	const cmdLinePad = Math.max(1, innerWidth - 1 - 1 - visibleLength(snapshot.command) - 1);
	const cmdLineFull = `${cmdLine}${" ".repeat(cmdLinePad)}${sideClose}`;
	lines.push(`   ${top}`);
	lines.push(`   ${cmdLineFull}`);
	lines.push(`   ${bottom}`);
	lines.push("");

	// Description lines (em-dash leader on first)
	for (let i = 0; i < snapshot.descriptionLines.length; i++) {
		const prefix = i === 0 ? "— " : "  ";
		lines.push(`   ${colorHex(`${prefix}${snapshot.descriptionLines[i]}`, CATHEDRAL_TOKENS.colors.foregroundDim)}`);
	}

	lines.push("");
	lines.push(divider(width));

	// Bottom row: ■ SYSTEM NOTICE   [Y]ES  [N]O  [A]LWAYS (right-aligned)
	const systemNotice = `${colorHex("■", CATHEDRAL_TOKENS.colors.states.approval)} ${colorHex("SYSTEM NOTICE", CATHEDRAL_TOKENS.colors.foregroundDim)}`;
	const buttons = DEFAULT_BUTTON_ORDER.map((c) => renderButton(c, c === snapshot.activeButton)).join(" ");
	const left = `   ${systemNotice}`;
	const right = `${buttons}   `;
	const gap = Math.max(2, width - visibleLength(left) - visibleLength(right));
	lines.push(`${left}${" ".repeat(gap)}${right}`);

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
// Dangerous command detection
// ============================================================================

/**
 * Patterns that trigger the approval modal for bash commands.
 * Matches Pi's own permission-gate.ts example: rm -rf, sudo, chmod 777,
 * plus gh CLI commands that mutate remote state.
 *
 * Regular edit/write/read are NOT gated — Pi doesn't gate them natively
 * and they slow down agent iteration.
 */
const DANGEROUS_BASH_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[\w]*r[\w]*|--recursive)/i,  // rm -rf, rm -r, rm --recursive
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bmkfs\b/i,
	/\bdd\b.*\bof=/i,
	/\b(shutdown|reboot|halt|poweroff)\b/i,
	/\bgit\s+push\b.*--force(?!-with-lease)/i,  // force push (without --force-with-lease)
	/\bgit\s+(reset\s+--hard|clean\s+-fd)/i,
];

/**
 * gh CLI sub-commands that mutate remote state and warrant approval.
 * Read-only commands (gh issue view, gh pr list, gh api GET) are NOT gated.
 */
const GH_MUTATING_PATTERNS: readonly RegExp[] = [
	/\bgh\s+pr\s+(create|merge|close|edit|ready|review)\b/i,
	/\bgh\s+issue\s+(create|close|edit|delete|transfer|pin)\b/i,
	/\bgh\s+release\s+(create|delete|edit)\b/i,
	/\bgh\s+repo\s+(create|delete|fork|rename|archive)\b/i,
	/\bgh\s+api\b.*(-X\s+(POST|PUT|PATCH|DELETE)|--method\s+(POST|PUT|PATCH|DELETE))/i,
];

export function isDangerousBashCommand(command: string): boolean {
	return DANGEROUS_BASH_PATTERNS.some((p) => p.test(command))
		|| GH_MUTATING_PATTERNS.some((p) => p.test(command));
}

/**
 * Sumo-side session allow set, populated by `[A]lways` selections.
 * Cleared on extension reload. Keyed by command string.
 */
const sessionAllowSet = new Set<string>();

function describeCommand(command: string): { command: string; description: string[] } {
	if (GH_MUTATING_PATTERNS.some((p) => p.test(command))) {
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
