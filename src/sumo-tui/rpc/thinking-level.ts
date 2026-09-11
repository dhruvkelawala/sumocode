import type { RpcSessionState } from "@earendil-works/pi-coding-agent";

export type RpcThinkingLevel = RpcSessionState["thinkingLevel"];
type RpcJsonValue = string | number | boolean | null | RpcJsonValue[] | { [key: string]: RpcJsonValue };

const RPC_THINKING_LEVEL_REGISTRY = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} as const satisfies Record<RpcThinkingLevel, true>;

export function isRpcThinkingLevel(value: RpcJsonValue | undefined): value is RpcThinkingLevel {
	return typeof value === "string" && Object.hasOwn(RPC_THINKING_LEVEL_REGISTRY, value);
}

export const RPC_THINKING_LEVELS = Object.freeze(Object.keys(RPC_THINKING_LEVEL_REGISTRY).filter(isRpcThinkingLevel));
