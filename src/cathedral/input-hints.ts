/**
 * Cathedral input keybind hint row (Elements 3 + 4 from CATHEDRAL_DECISIONS.md).
 *
 * Active state (Element 4):
 *   right-aligned dim:    TAB · AGENTS  CTRL+/ · COMMANDS
 *
 * Splash state (Element 3):
 *   left dim flavour:     └─ AWAITING DIVINE INVOCATION
 *   right-aligned dim:    TAB · AGENTS  CTRL+/ · COMMANDS
 *
 * Mounted via `setWidget(..., { placement: "belowEditor" })`.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { formatCwd } from "../footer.js";
import { getGitBranch, sessionHasMessages as cachedSessionHasMessages } from "../session-cache.js";
import { INPUT_FRAME_HINT_AWAITING, renderInputHints } from "./input-frame.js";

const SPLASH_INPUT_FRAME_WIDTH = 60;
const ACTIVE_HINT_HORIZONTAL_PADDING = 1;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function centerAnsi(line: string, width: number): string {
	const visible = visibleWidth(line.replace(ANSI_PATTERN, ""));
	if (visible >= width) return line;
	const left = Math.floor((width - visible) / 2);
	const right = width - visible - left;
	return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
}

class InputHintsComponent implements Component {
	constructor(
		private readonly isSplash: () => boolean,
		private readonly activeLeftHint: () => string | undefined,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (this.isSplash()) {
			// On splash the hint row is visually part of the centered invocation
			// block. Return just the hint (no leading blank) so Pi's belowEditor
			// slot stays compact and the input frame sits close to the content.
			const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
			return [centerAnsi(renderInputHints(frameWidth, { leftHint: INPUT_FRAME_HINT_AWAITING }), width)];
		}
		// Active bottom breathing rows are owned by the retained shell layout shim,
		// not by the hint component. This keeps the component semantic: one hint row.
		const pad = width > ACTIVE_HINT_HORIZONTAL_PADDING * 2 ? ACTIVE_HINT_HORIZONTAL_PADDING : 0;
		const innerWidth = Math.max(0, width - pad * 2);
		const hint = renderInputHints(innerWidth, { leftHint: this.activeLeftHint(), leftHintOverflow: "truncate", leftHintStyle: "project-branch" });
		return [`${" ".repeat(pad)}${hint}${" ".repeat(pad)}`];
	}
}

function activeContextHint(ctx: ExtensionContext): string | undefined {
	const cwd = ctx.cwd;
	if (!cwd) return undefined;
	const project = formatCwd(cwd);
	const branch = getGitBranch(ctx);
	return branch ? `${project} (${branch})` : project;
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return cachedSessionHasMessages(ctx);
	} catch {
		return false;
	}
}

export function installInputHints(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"sumocode-input-hints",
			() => new InputHintsComponent(() => !sessionHasMessages(ctx), () => activeContextHint(ctx)),
			{ placement: "belowEditor" },
		);
	});
}
