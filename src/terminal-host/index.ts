import { detectTerminalHost } from "./detect.js";
import { herdrTerminalHost } from "./herdr.js";
import type { TerminalHost } from "./types.js";

const noneTerminalHost: TerminalHost = {
	kind: "none",
	async startAgentPane() { return { ok: false, error: "requires a running herdr terminal host" }; },
	async sendPaneText() { return { ok: false, error: "requires a running herdr terminal host" }; },
	async openCommandInSplit() { return { ok: false, error: "requires a running herdr terminal host" }; },
	async closePane() { return { ok: false, error: "requires a running herdr terminal host" }; },
	async notify() {},
};

export function getTerminalHost(env: NodeJS.ProcessEnv = process.env): TerminalHost {
	const kind = detectTerminalHost(env);
	return kind === "herdr" ? herdrTerminalHost : noneTerminalHost;
}

export { detectTerminalHost } from "./detect.js";
export type {
	AgentPanePlacement,
	HostResult,
	PaneRef,
	PiExecLike,
	SplitDirection,
	StartAgentPaneOptions,
	StartedAgentPane,
	TerminalHost,
	TerminalHostKind,
} from "./types.js";
