import type { RpcSessionState } from "@earendil-works/pi-coding-agent";

export type RpcThinkingLevel = RpcSessionState["thinkingLevel"];
type RpcJsonValue = string | number | boolean | null | RpcJsonValue[] | { [key: string]: RpcJsonValue };

export const RPC_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly RpcThinkingLevel[];

export function isRpcThinkingLevel(value: RpcJsonValue | undefined): value is RpcThinkingLevel {
	return RPC_THINKING_LEVELS.some((level) => level === value);
}
