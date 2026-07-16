import type { TerminalHostKind } from "./types.js";

export function detectTerminalHost(env: NodeJS.ProcessEnv = process.env): TerminalHostKind {
	if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) return "herdr";
	if (env.CMUX_SURFACE_ID || env.CMUX_WORKSPACE_ID) return "cmux";
	return "none";
}
