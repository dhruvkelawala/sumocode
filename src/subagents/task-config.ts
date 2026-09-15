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
 * Two fail-closed rules live here rather than in the launchers:
 *   - A role that grants nothing inherits the parent's BUILT-INS only. Extension
 *     tools are never inherited implicitly, because the parent's own surface
 *     (an interactive operator session) routinely includes tools a delegated
 *     child was never granted.
 *   - An explicitly granted extension tool still requires the parent to have it
 *     active, so a narrowed parent cannot widen its child.
 */
export const resolveChildToolSurface = (options: {
	readonly roleTools: readonly string[] | undefined;
	readonly parentActiveTools: readonly string[];
}): ChildToolName[] => {
	const parentActive = new Set(options.parentActiveTools);
	if (options.roleTools === undefined) return options.parentActiveTools.filter(isBuiltInToolName);
	const surface: ChildToolName[] = [];
	for (const toolName of options.roleTools) {
		if (!isChildToolName(toolName) || !parentActive.has(toolName) || surface.includes(toolName)) continue;
		surface.push(toolName);
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
