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

function roleLimits(role: SubagentRole): string[] {
	const limits = [role.model === undefined ? "inherits your model" : `model ${role.model}`];
	if (role.tools !== undefined) limits.push(role.tools.length === 0 ? "no tools" : `tools: ${role.tools.join(", ")}`);
	if (role.mcpServers !== undefined) limits.push(role.mcpServers.length === 0 ? "no MCP" : `MCP: ${role.mcpServers.join(", ")}`);
	return limits;
}

/**
 * System-prompt section that maps SumoCode's subagent roles onto T3's
 * `delegate_task`, which replaces the `subagent_*` tools inside T3 Code so
 * child work shows up in the app. `roleWarnings` are roles.json problems: in
 * this profile the prompt is the one place they reach the model and the user.
 */
export function buildT3RoleGuidance(roles: readonly SubagentRole[], roleWarnings: readonly string[] = []): string {
	const roleLines = roles.map((role) => `- ${role.id} (${roleLimits(role).join("; ")}): ${role.systemPrompt}`);
	const isolated = roles.filter((role) => role.defaultWorktree === true).map((role) => role.id);
	return [
		"## SumoCode roles in T3 Code",
		"",
		"SumoCode's subagent tools are off inside T3 Code. Delegate with T3's `delegate_task` so child work appears in the app.",
		"To run a SumoCode role, set `target.providerInstanceId` to the Pi provider instance (driverKind `pi` in `orchestrator_capabilities`), set `target.model` to the role's model when one is listed, and start the task with the role's instructions:",
		...roleLines,
		"`delegate_task` cannot fence a child's tools, so when a role lists tools or MCP servers, state in the task that those are the only ones the child may use.",
		...isolated.length > 0
			? [`Children share this thread's checkout. SumoCode would isolate ${isolated.join(", ")} in a git worktree, so give those children files you are not editing, or ask the user for a separate worktree thread.`]
			: [],
		...roleWarnings.length > 0
			? ["roles.json has problems, so some roles above may be built-in defaults. Tell the user if they ask for one of these:", ...roleWarnings.map((warning) => `- ${warning}`)]
			: [],
	].join("\n");
}
