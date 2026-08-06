import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const RPC_TREE_NAVIGATION_COMMAND = "sumo:rpc-tree-navigate";
export const RPC_TREE_NAVIGATION_RESULT_STATUS_KEY = "sumocode.rpc-tree-navigation-result";
export const MAX_TREE_NAVIGATION_ENCODED_BYTES = 24_576;
export const MAX_TREE_NAVIGATION_JSON_BYTES = 18_432;
export const MAX_TREE_NAVIGATION_TARGET_BYTES = 256;
export const MAX_TREE_NAVIGATION_INSTRUCTIONS_BYTES = 16_384;
// Requests and correlated outcomes have different budgets. The request cap
// protects the prompt command; the outcome budget must carry a useful selected
// draft without allowing an arbitrarily large session entry onto the status
// side channel.
export const MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES = 20_480;
export const MAX_TREE_NAVIGATION_OUTCOME_JSON_BYTES = 24_576;
export const MAX_TREE_NAVIGATION_OUTCOME_ENCODED_BYTES = 32_768;

export interface RpcTreeNavigationRequest {
	readonly requestId: string;
	readonly targetId: string;
	readonly summarize: boolean;
	readonly customInstructions?: string;
}

export interface RpcTreeNavigationOutcome {
	readonly requestId: string;
	readonly status: "committed" | "cancelled" | "error";
	readonly leafId: string | null;
	readonly editorText?: string;
}

export interface RpcTreeNavigationOutcomeBroker {
	register(requestId: string, timeoutMs: number): Promise<RpcTreeNavigationOutcome>;
	publish(outcome: RpcTreeNavigationOutcome): void;
	cancel(requestId: string): void;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isCanonicalUuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isControlCharacter(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return code <= 0x1f || code === 0x7f;
}

function decodeBase64Url(encoded: string): Uint8Array {
	if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("tree navigation payload is not canonical base64url");
	const decoded = Buffer.from(encoded, "base64url");
	if (decoded.length === 0 || decoded.toString("base64url") !== encoded) throw new Error("tree navigation payload is not canonical base64url");
	return decoded;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sortedAllowed = [...allowed].sort();
	return keys.length === sortedAllowed.length && keys.every((key, index) => key === sortedAllowed[index]);
}

export function validateRpcTreeNavigationRequest(value: unknown): asserts value is RpcTreeNavigationRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tree navigation request must be an object");
	const record = value as unknown as Record<string, unknown>;
	const allowed = record.summarize === true
		? ["requestId", "targetId", "summarize", ...(Object.hasOwn(record, "customInstructions") ? ["customInstructions"] : [])]
		: ["requestId", "targetId", "summarize"];
	if (!exactKeys(record, allowed)) throw new Error("tree navigation request has unknown or invalid fields");
	if (!isCanonicalUuid(record.requestId)) throw new Error("tree navigation requestId must be a canonical UUID");
	if (typeof record.targetId !== "string") throw new Error("tree navigation targetId must be a string");
	const targetId = record.targetId.trim();
	if (utf8Bytes(targetId) < 1 || utf8Bytes(targetId) > MAX_TREE_NAVIGATION_TARGET_BYTES || [...targetId].some(isControlCharacter)) {
		throw new Error("tree navigation targetId is invalid");
	}
	if (typeof record.summarize !== "boolean") throw new Error("tree navigation summarize must be boolean");
	if (record.summarize === false && Object.hasOwn(record, "customInstructions")) throw new Error("customInstructions requires summarize");
	if (record.summarize === true && Object.hasOwn(record, "customInstructions") && (typeof record.customInstructions !== "string" || utf8Bytes(record.customInstructions) > MAX_TREE_NAVIGATION_INSTRUCTIONS_BYTES)) {
		throw new Error("tree navigation customInstructions is too large");
	}
}

function parseRequestJson(decoded: Uint8Array): RpcTreeNavigationRequest {
	if (decoded.byteLength > MAX_TREE_NAVIGATION_JSON_BYTES) throw new Error("tree navigation payload is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(decoded).toString("utf8"));
	} catch {
		throw new Error("tree navigation payload is malformed JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("tree navigation payload must be an object");
	validateRpcTreeNavigationRequest(parsed);
	const record = parsed as unknown as Record<string, unknown>;
	return {
		requestId: record.requestId as string,
		targetId: (record.targetId as string).trim(),
		summarize: record.summarize as boolean,
		...(typeof record.customInstructions === "string" ? { customInstructions: record.customInstructions } : {}),
	};
}

export function encodeRpcTreeNavigationPayload(request: RpcTreeNavigationRequest): string {
	validateRpcTreeNavigationRequest(request);
	const json = JSON.stringify(request);
	const encoded = Buffer.from(json, "utf8").toString("base64url");
	if (utf8Bytes(encoded) > MAX_TREE_NAVIGATION_ENCODED_BYTES) throw new Error("tree navigation payload is too large");
	return encoded;
}

export function decodeRpcTreeNavigationPayload(encoded: string): RpcTreeNavigationRequest {
	if (utf8Bytes(encoded) > MAX_TREE_NAVIGATION_ENCODED_BYTES) throw new Error("tree navigation payload is too large");
	return parseRequestJson(decodeBase64Url(encoded));
}

function boundedOutcome(outcome: RpcTreeNavigationOutcome): RpcTreeNavigationOutcome {
	if (outcome.editorText !== undefined && utf8Bytes(outcome.editorText) > MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES) {
		const withoutEditorText = { ...outcome } as { requestId: string; status: RpcTreeNavigationOutcome["status"]; leafId: string | null; editorText?: string };
		delete withoutEditorText.editorText;
		return withoutEditorText;
	}
	return outcome;
}

export function encodeRpcTreeNavigationOutcome(outcome: RpcTreeNavigationOutcome): string {
	const bounded = boundedOutcome(outcome);
	const json = JSON.stringify(bounded);
	if (utf8Bytes(json) > MAX_TREE_NAVIGATION_OUTCOME_JSON_BYTES) throw new Error("tree navigation outcome is too large");
	return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeRpcTreeNavigationOutcome(encoded: string): RpcTreeNavigationOutcome {
	if (utf8Bytes(encoded) > MAX_TREE_NAVIGATION_OUTCOME_ENCODED_BYTES) throw new Error("tree navigation outcome is too large");
	const decoded = decodeBase64Url(encoded);
	if (decoded.byteLength > MAX_TREE_NAVIGATION_OUTCOME_JSON_BYTES) throw new Error("tree navigation outcome is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(decoded).toString("utf8"));
	} catch {
		throw new Error("tree navigation outcome is malformed JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("tree navigation outcome must be an object");
	const record = parsed as Record<string, unknown>;
	const outcomeKeys = Object.hasOwn(record, "editorText") ? ["editorText", "leafId", "requestId", "status"] : ["leafId", "requestId", "status"];
	if (!exactKeys(record, outcomeKeys)) throw new Error("tree navigation outcome has unknown fields");
	if (!isCanonicalUuid(record.requestId) || (record.status !== "committed" && record.status !== "cancelled" && record.status !== "error")) {
		throw new Error("tree navigation outcome is invalid");
	}
	if (record.leafId !== null && typeof record.leafId !== "string") throw new Error("tree navigation outcome leafId is invalid");
	if (Object.hasOwn(record, "editorText") && (typeof record.editorText !== "string" || utf8Bytes(record.editorText) > MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES)) throw new Error("tree navigation outcome editorText is invalid");
	return {
		requestId: record.requestId,
		status: record.status,
		leafId: record.leafId,
		...(typeof record.editorText === "string" ? { editorText: record.editorText } : {}),
	};
}

function entryEditorText(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as { type?: unknown; message?: unknown; content?: unknown };
	if (record.type === "message") {
		if (typeof record.message !== "object" || record.message === null) return undefined;
		const message = record.message as { role?: unknown; content?: unknown };
		if (message.role !== "user") return undefined;
		const text = contentText(message.content);
		return utf8Bytes(text) <= MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES ? text : undefined;
	}
	if (record.type === "custom_message") {
		const text = contentText(record.content);
		return utf8Bytes(text) <= MAX_TREE_NAVIGATION_EDITOR_TEXT_BYTES ? text : undefined;
	}
	return undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("");
}

function recoverRequestId(encoded: string): string | undefined {
	try {
		if (utf8Bytes(encoded) > MAX_TREE_NAVIGATION_ENCODED_BYTES) return undefined;
		const decoded = decodeBase64Url(encoded);
		const parsed = JSON.parse(Buffer.from(decoded).toString("utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const requestId = (parsed as Record<string, unknown>).requestId;
		return isCanonicalUuid(requestId) ? requestId : undefined;
	} catch {
		return undefined;
	}
}

function publishTreeNavigationError(ctx: ExtensionCommandContext, requestId: string): void {
	const outcome: RpcTreeNavigationOutcome = { requestId, status: "error", leafId: ctx.sessionManager.getLeafId() };
	ctx.ui.setStatus(RPC_TREE_NAVIGATION_RESULT_STATUS_KEY, encodeRpcTreeNavigationOutcome(outcome));
	ctx.ui.notify("invalid tree navigation request", "warning");
}

export async function executeRpcTreeNavigation(encoded: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "rpc" || !ctx.hasUI) {
		ctx.ui.notify("tree navigation requires SumoCode RPC mode", "warning");
		return;
	}
	let request: RpcTreeNavigationRequest;
	try {
		request = decodeRpcTreeNavigationPayload(encoded);
	} catch {
		const requestId = recoverRequestId(encoded);
		if (requestId) publishTreeNavigationError(ctx, requestId);
		else ctx.ui.notify("invalid tree navigation request", "warning");
		return;
	}

	let editorText: string | undefined;
	try {
		editorText = entryEditorText(ctx.sessionManager.getEntry(request.targetId));
		const result = await ctx.navigateTree(request.targetId, {
			summarize: request.summarize,
			...(request.customInstructions === undefined ? {} : { customInstructions: request.customInstructions }),
		});
		const outcome: RpcTreeNavigationOutcome = {
			requestId: request.requestId,
			status: result.cancelled ? "cancelled" : "committed",
			leafId: ctx.sessionManager.getLeafId(),
			...(result.cancelled || editorText === undefined ? {} : { editorText }),
		};
		ctx.ui.setStatus(RPC_TREE_NAVIGATION_RESULT_STATUS_KEY, encodeRpcTreeNavigationOutcome(outcome));
	} catch {
		const outcome: RpcTreeNavigationOutcome = {
			requestId: request.requestId,
			status: "error",
			leafId: ctx.sessionManager.getLeafId(),
		};
		ctx.ui.setStatus(RPC_TREE_NAVIGATION_RESULT_STATUS_KEY, encodeRpcTreeNavigationOutcome(outcome));
		ctx.ui.notify("tree navigation failed", "error");
	}
}

export function registerRpcTreeNavigationCommand(pi: ExtensionAPI): void {
	pi.registerCommand(RPC_TREE_NAVIGATION_COMMAND, {
		description: "Navigate the current session tree",
		handler: async (args, ctx) => executeRpcTreeNavigation(args.trim(), ctx),
	});
}

export class InMemoryRpcTreeNavigationOutcomeBroker implements RpcTreeNavigationOutcomeBroker {
	private readonly waiters = new Map<string, { resolve(outcome: RpcTreeNavigationOutcome): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

	public register(requestId: string, timeoutMs: number): Promise<RpcTreeNavigationOutcome> {
		if (this.waiters.has(requestId)) return Promise.reject(new Error("tree navigation request is already pending"));
		return new Promise<RpcTreeNavigationOutcome>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(requestId);
				reject(new Error(`Timed out waiting for tree navigation outcome after ${timeoutMs}ms`));
			}, timeoutMs);
			this.waiters.set(requestId, { resolve, reject, timer });
		});
	}

	public publish(outcome: RpcTreeNavigationOutcome): void {
		const waiter = this.waiters.get(outcome.requestId);
		if (!waiter) return;
		this.waiters.delete(outcome.requestId);
		clearTimeout(waiter.timer);
		waiter.resolve(outcome);
	}

	public cancel(requestId: string): void {
		const waiter = this.waiters.get(requestId);
		if (!waiter) return;
		this.waiters.delete(requestId);
		clearTimeout(waiter.timer);
		waiter.reject(new Error("tree navigation outcome waiter cancelled"));
	}
}