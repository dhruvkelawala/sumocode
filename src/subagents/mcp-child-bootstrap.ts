import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MCP_GATEWAY_TOOL } from "./task-config.js";

type TerminateChild = (message: string) => never;

const terminateChild: TerminateChild = (message) => {
	// Pi catches event handler exceptions, and print mode does not bind
	// ExtensionContext.shutdown. A direct non-zero exit is the only fail-closed
	// boundary that guarantees the child never runs a prompt claiming an MCP
	// capability it does not have.
	process.stderr.write(`[sumocode] ${message}\n`);
	process.exit(1);
};

/**
 * Fail closed when a child was launched with an MCP capability it did not get.
 *
 * Pi's `--tools` allowlist silently drops unknown names, so a missing adapter,
 * a rejected capability config, or a future adapter rename would otherwise
 * launch a child that simply has no MCP tool while its task metadata claims
 * one. This entry is loaded through `-e` alongside the adapter and checks the
 * settled registry immediately before the first model call.
 */
export default function installMcpChildBootstrap(pi: ExtensionAPI, terminate: TerminateChild = terminateChild): void {
	pi.on("before_agent_start", () => {
		if (pi.getActiveTools().includes(MCP_GATEWAY_TOOL)) return;
		terminate(`MCP capability unavailable: the ${MCP_GATEWAY_TOOL} tool was not registered for this child`);
	});
}
