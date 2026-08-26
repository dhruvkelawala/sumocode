import type { TerminalHostKind } from "./types.js";

export function detectTerminalHost(env: NodeJS.ProcessEnv = process.env): TerminalHostKind {
	return env.HERDR_ENV === "1" && env.HERDR_PANE_ID ? "herdr" : "none";
}
