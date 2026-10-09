import type { SubagentRole } from "./subagents/roles.js";

/**
 * Set by `sumocode-pi-cli` (src/native/sumocode-pi-cli.sh) for apps that drive
 * Pi themselves, such as T3 Code. The app owns the screen, so SumoCode installs
 * only what works through Pi's RPC dialogs. The marker reaches every process
 * the app starts, including its command-discovery probe, so the slash commands
 * the app lists match the ones its chat sessions have.
 */
export const APP_HOST_ENV = "SUMOCODE_APP_HOST";

export function isAppHostProfile(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[APP_HOST_ENV] === "1";
}

/**
 * T3 Code injected its bridge extension into this session, so T3's
 * `delegate_task` and `task_status` tools exist. T3 sets both variables only
 * for chat sessions, never for its discovery or text-generation processes.
 */
export function hasT3Orchestration(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.T3_MCP_URL) && Boolean(env.T3_MCP_BEARER_TOKEN);
}

/**
 * System-prompt section that maps SumoCode's subagent roles onto T3's
 * `delegate_task`, which replaces the `subagent_*` tools inside T3 Code so
 * child work shows up in the app.
 */
export function buildT3RoleGuidance(roles: readonly SubagentRole[]): string {
	const roleLines = roles.map((role) => {
		const model = role.model === undefined ? "inherits your model" : `model ${role.model}`;
		return `- ${role.id} (${model}): ${role.systemPrompt}`;
	});
	const isolated = roles.filter((role) => role.defaultWorktree === true).map((role) => role.id);
	return [
		"## SumoCode roles in T3 Code",
		"",
		"SumoCode's subagent tools are off inside T3 Code. Delegate with T3's `delegate_task` so child work appears in the app.",
		"To run a SumoCode role, set `target.providerInstanceId` to the Pi provider instance (driverKind `pi` in `orchestrator_capabilities`), set `target.model` to the role's model when one is listed, and start the task with the role's instructions:",
		...roleLines,
		...isolated.length > 0
			? [`Children share this thread's checkout. SumoCode would isolate ${isolated.join(", ")} in a git worktree, so give those children files you are not editing, or ask the user for a separate worktree thread.`]
			: [],
	].join("\n");
}
