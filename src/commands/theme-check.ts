import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderThemeCheck, type ThemeReader } from "../theme-check.js";

/**
 * `/sumo:theme-check` — open a full-width overlay that exercises every Pi
 * theme color slot SumoCode cares about. Used both as a debug helper for
 * humans verifying the active theme, and as a deterministic vhs scenario
 * (`docs/visual/cathedral-theme-check.tape`) confirming `cathedral.json` is
 * loaded and applied.
 */
export function registerThemeCheckCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:theme-check", {
		description: "Open a Cathedral theme verification card",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				process.stdout.write("theme-check requires a TTY\n");
				return;
			}
			if (ctx.mode === "rpc") {
				ctx.ui.notify("theme-check overlay unavailable in RPC mode", "warning");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme: Theme, _keybindings, done): Component => {
					const reader: ThemeReader = {
						fg: (slot, text) => theme.fg(slot, text),
						bg: (slot, text) => theme.bg(slot, text),
					};

					return {
						invalidate(): void {
							tui.requestRender();
						},
						render(width: number): string[] {
							return renderThemeCheck(reader, Math.max(40, Math.min(width, 120)));
						},
						handleInput(_data: string): void {
							done();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: 120,
						maxHeight: "100%",
					},
				},
			);
		},
	});
}
