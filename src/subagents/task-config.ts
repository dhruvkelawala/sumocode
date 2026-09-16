import type { ProviderModel, TaskThinking, ThinkingLevel } from "./task-params.js";
import { resolveModel } from "./task-params.js";

export const BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type BuiltInToolName = (typeof BUILT_IN_TOOLS)[number];

/**
 * The MCP gateway tool. MCP is not a Pi built-in — the name only resolves when
 * the `pi-mcp-adapter` extension registers it — but Pi's `--tools` allowlist
 * spans built-in, extension, and custom tools, so a child that loads the
 * adapter and lists this name gets the gateway.
 */
export const MCP_GATEWAY_TOOL = "mcp";

/**
 * Extension tools a role may explicitly grant. Deliberately a closed set: every
 * name here is a capability whose blast radius the caller must opt into, and
 * widening it is a review decision, not a configuration one.
 */
export const APPROVABLE_EXTENSION_TOOLS = [MCP_GATEWAY_TOOL] as const;

export type ApprovableExtensionTool = (typeof APPROVABLE_EXTENSION_TOOLS)[number];

/** Bound on the MCP server list a role may select. One limit for every stage. */
export const MAX_MCP_SERVERS = 256;
export type ChildToolName = BuiltInToolName | ApprovableExtensionTool;

const isBuiltInToolName = (toolName: string): toolName is BuiltInToolName => {
	// SAFETY: widening the BUILT_IN_TOOLS literal tuple to readonly string[] only relaxes the
	// element type for `includes`; membership still proves toolName is a BuiltInToolName.
	return (BUILT_IN_TOOLS as readonly string[]).includes(toolName);
};

export const isApprovableExtensionTool = (toolName: string): toolName is ApprovableExtensionTool => {
	// SAFETY: widening the APPROVABLE_EXTENSION_TOOLS literal tuple to readonly string[] only
	// relaxes the element type for `includes`; membership still proves toolName is
	// an ApprovableExtensionTool.
	return (APPROVABLE_EXTENSION_TOOLS as readonly string[]).includes(toolName);
};

export const isChildToolName = (toolName: string): toolName is ChildToolName =>
	isBuiltInToolName(toolName) || isApprovableExtensionTool(toolName);

/**
 * Resolve what a child may use: role policy intersected with the parent's own
 * active tools, so delegation can only narrow.
 *
 * Fail-closed rules that live here rather than in the launchers:
 *   - A role list can only name built-ins and approvable extension tools that
 *     the parent itself has active, so a narrowed parent cannot widen its child.
 *   - The MCP gateway is inherited whenever the parent has it active. Delegation
 *     never grants more than the parent, and a parent without the gateway
 *     cannot conjure one for its children.
 */
export const resolveChildToolSurface = (options: {
	readonly roleTools: readonly string[] | undefined;
	readonly parentActiveTools: readonly string[];
	/** True when a role asked for the gateway by name; see the implicit rule below. */
	readonly mcpExplicit?: boolean;
}): ChildToolName[] => {
	const parentActive = new Set(options.parentActiveTools);
	const surface: ChildToolName[] = [];
	const push = (toolName: string): void => {
		if (isChildToolName(toolName) && parentActive.has(toolName) && !surface.includes(toolName)) surface.push(toolName);
	};
	if (options.roleTools === undefined) {
		for (const toolName of options.parentActiveTools) {
			if (isBuiltInToolName(toolName)) push(toolName);
		}
	} else {
		for (const toolName of options.roleTools) push(toolName);
	}
	// The MCP gateway is inherited, like a built-in, on one condition: the child
	// can already start a subprocess. A gateway server is a command, so granting
	// it to a surface without `bash` would hand a role that was deliberately
	// narrowed away from shell access the very authority its role removed. A
	// role may always ask for it by name, and `mcpServers` narrows the scope.
	if (parentActive.has(MCP_GATEWAY_TOOL) && (options.mcpExplicit === true || surface.includes("bash"))) {
		push(MCP_GATEWAY_TOOL);
	}
	return surface;
};

const resolveThinkingLevel = (thinking: TaskThinking, inherited: ThinkingLevel): ThinkingLevel => {
	return thinking === "inherit" ? inherited : thinking;
};

const buildSubprocessArgs = (options: {
	model: ProviderModel | undefined;
	thinkingLevel: ThinkingLevel;
	tools: readonly string[];
}): string[] => {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];

	if (options.model) {
		args.push("--provider", options.model.provider);
		args.push("--model", options.model.modelId);
	}

	args.push("--thinking", options.thinkingLevel);

	if (options.tools.length === 0) {
		args.push("--no-tools");
	} else {
		args.push("--tools", options.tools.join(","));
	}

	return args;
};

export const resolveTaskConfig = (options: {
	item: { model?: string; thinking?: TaskThinking };
	defaultModel: string | undefined;
	defaultThinking: TaskThinking;
	inheritedThinking: ThinkingLevel;
	ctxModel: { provider: string; id: string } | undefined;
	tools: readonly ChildToolName[];
}):
	| { ok: true; thinkingLevel: ThinkingLevel; subprocessArgs: string[]; modelLabel: string | undefined }
	| { ok: false; error: string } => {
	const modelOverride = options.item.model ?? options.defaultModel;
	const modelResolution = resolveModel(modelOverride, options.ctxModel);
	if (!modelResolution.ok) return modelResolution;

	const thinking = resolveThinkingLevel(options.item.thinking ?? options.defaultThinking, options.inheritedThinking);
	const subprocessArgs = buildSubprocessArgs({
		model: modelResolution.model,
		thinkingLevel: thinking,
		tools: options.tools,
	});

	return { ok: true, thinkingLevel: thinking, subprocessArgs, modelLabel: modelResolution.model?.label };
};
