import type { RpcResponse } from "@earendil-works/pi-coding-agent";

export type RpcSuccessResponse = Extract<RpcResponse, { success: true }>;
export type RpcSuccessCommand = RpcSuccessResponse["command"];
export type RpcSuccessResponseFor<C extends RpcSuccessCommand> = Extract<RpcSuccessResponse, { command: C }>;
export type RpcResponseData<C extends RpcSuccessCommand> = RpcSuccessResponseFor<C> extends { data: infer Data } ? Data : undefined;

export function expectRpcSuccess<C extends RpcSuccessCommand>(response: RpcResponse, command: C): RpcSuccessResponseFor<C> {
	if (response.success === false) throw new Error(`${command} failed: ${response.error}`);
	if (response.command !== command) throw new Error(`${command} failed: unexpected response command ${response.command}`);
	return response as RpcSuccessResponseFor<C>;
}

export function responseData<C extends RpcSuccessCommand>(response: RpcResponse, command: C): RpcResponseData<C> {
	const success = expectRpcSuccess(response, command);
	return ("data" in success ? success.data : undefined) as RpcResponseData<C>;
}
