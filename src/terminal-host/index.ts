import { cmuxTerminalHost } from "./cmux.js";
import { detectTerminalHost } from "./detect.js";
import { herdrTerminalHost } from "./herdr.js";
import type { PaneRef, TerminalHost } from "./types.js";

const noneTerminalHost: TerminalHost = {
	kind: "none",
	async openCommandInSplit() { return { ok: false, error: "requires a terminal host (cmux or herdr)" }; },
	async closePane() { return { ok: false, error: "requires a terminal host (cmux or herdr)" }; },
	async notify() {},
};

export function getTerminalHost(env: NodeJS.ProcessEnv = process.env): TerminalHost {
	const kind = detectTerminalHost(env);
	if (kind === "herdr") return herdrTerminalHost;
	if (kind === "cmux") return cmuxTerminalHost;
	return noneTerminalHost;
}

export function getTerminalHostForPane(pane: PaneRef): TerminalHost {
	return pane.host === "herdr" ? herdrTerminalHost : cmuxTerminalHost;
}

export { detectTerminalHost } from "./detect.js";
export type { PaneRef, TerminalHost, TerminalHostKind, HostResult, PiExecLike, SplitDirection } from "./types.js";
