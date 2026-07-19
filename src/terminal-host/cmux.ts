import { openCommandInCurrentSurface, openCommandInNewSplitWithRefs } from "../commands/cmux-split.js";
import type { PaneRef, PiExecLike, SplitDirection, TerminalHost } from "./types.js";

export const cmuxTerminalHost = {
	kind: "cmux",
	async startAgentPane(pi, options) {
		const result = await this.openCommandInSplit(pi, "right", options);
		if (!result.ok) return result;
		return {
			ok: true,
			pane: result.pane,
			agentName: options.name,
			workspaceId: result.pane.workspaceId,
			paneId: result.pane.paneId,
		};
	},
	async sendPaneText(_pi: PiExecLike, _pane: PaneRef, _text: string) {
		return { ok: false, error: "not supported on cmux" };
	},
	async openCommandInSplit(pi: PiExecLike, direction: SplitDirection, options: { cwd: string; shellCommand: string }) {
		const result = await openCommandInNewSplitWithRefs(pi as never, direction, options.shellCommand);
		if (!result.ok) return result;
		return { ok: true, pane: { host: "cmux", paneId: result.surfaceRef, workspaceId: result.workspaceRef } };
	},
	async replaceCurrentPane(pi: PiExecLike, options: { shellCommand: string }) {
		return openCommandInCurrentSurface(pi as never, options.shellCommand);
	},
	async closePane(pi: PiExecLike, pane: PaneRef) {
		const result = await pi.exec("cmux", ["close-surface", "--workspace", pane.workspaceId ?? "", "--surface", pane.paneId], { timeout: 5000 });
		if (result.code !== 0) return { ok: false, error: result.stderr || result.stdout || `cmux close-surface exited ${result.code}` };
		return { ok: true };
	},
	async notify(pi: PiExecLike, title: string, body: string, pane?: PaneRef) {
		const args = ["notify", "--title", title, "--body", body];
		if (pane?.workspaceId) args.push("--workspace", pane.workspaceId);
		if (pane?.paneId) args.push("--surface", pane.paneId);
		await pi.exec("cmux", args, { timeout: 5000 }).catch(() => undefined);
	},
} satisfies TerminalHost;
