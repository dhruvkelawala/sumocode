/**
 * Cathedral input keybind hint row (Elements 3 + 4 from CATHEDRAL_DECISIONS.md).
 *
 * Active state (Element 4):
 *   right-aligned dim:    TAB · AGENTS  CTRL+/ · COMMANDS
 *
 * Splash state (Element 3):
 *   left dim context:     ╰─ <model> · <thinking>
 *   right-aligned dim:    CTRL+/ · COMMANDS
 *
 * Mounted via `setWidget(..., { placement: "belowEditor" })`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCwd } from "../footer.js";
import { getGitBranch, sessionHasMessages as cachedSessionHasMessages } from "../session-cache.js";
import { renderInputHints } from "./input-frame.js";

const SPLASH_INPUT_FRAME_WIDTH = 60;
const ACTIVE_HINT_HORIZONTAL_PADDING = 1;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
		private readonly splashLeftHint: () => string,
		private readonly activeLeftHint: () => string | undefined,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (this.isSplash()) {
			// On splash the hint row is visually part of the centered invocation
			// block. Return just the hint (no leading blank) so Pi's belowEditor
			// slot stays compact and the input frame sits close to the content.
			const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
			return [centerAnsi(renderInputHints(frameWidth, { leftHint: this.splashLeftHint(), leftHintStyle: "model-thinking" }), width)];
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

function latestThinkingLevel(ctx: ExtensionContext): ThinkingLevel | undefined {
	let latest: ThinkingLevel | undefined;
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "thinking_level_change") latest = entry.thinkingLevel as ThinkingLevel;
		}
	} catch {
		return undefined;
	}
	return latest;
}

function modelDisplayName(ctx: ExtensionContext): string {
	return ctx.model?.id ?? "no model";
}

function splashInvocationHint(modelId: string, thinkingLevel: ThinkingLevel | undefined): string {
	return `╰─ ${modelId} · ${thinkingLevel ?? "thinking"}`;
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return cachedSessionHasMessages(ctx);
	} catch {
		return false;
	}
}

export function installInputHints(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;
	let currentModelId = "no model";
	let currentThinkingLevel: ThinkingLevel | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		currentModelId = modelDisplayName(ctx);
		currentThinkingLevel = latestThinkingLevel(ctx);
		ctx.ui.setWidget(
			"sumocode-input-hints",
			(tui: TUI) => {
				requestRender = () => tui.requestRender();
				return new InputHintsComponent(
					() => !sessionHasMessages(ctx),
					() => splashInvocationHint(currentModelId, currentThinkingLevel),
					() => activeContextHint(ctx),
				);
			},
			{ placement: "belowEditor" },
		);
	});

	pi.on("model_select", (event) => {
		currentModelId = event.model.id;
		requestRender?.();
	});

	pi.on("thinking_level_select", (event) => {
		currentThinkingLevel = event.level;
		requestRender?.();
	});
}
