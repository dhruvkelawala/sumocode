/**
 * Long-lived Claude credentials for `/accounts`.
 *
 * `claude setup-token` mints a one-year, inference-only OAuth token that never
 * refreshes. Storing it as a static OAuth credential with an empty refresh
 * token is what makes an account survive: Pi's refresh path is never entered,
 * so a Claude.ai login's finite (~30 day) lifetime and refresh-token rotation
 * races cannot invalidate it. Pi's own OpenRouter provider uses the same
 * `{ type: "oauth", refresh: "", expires: MAX_SAFE_INTEGER }` shape for a
 * static token.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { OAuthCredential } from "@earendil-works/pi-ai";

/**
 * The mint child: stdout/stderr piped, stdin closed.
 *
 * Closing stdin is deliberate and verified against Claude Code 2.1.267: the
 * command authorizes through a localhost callback server and only *offers* a
 * code-paste prompt (`startOAuthFlow(..., {inferenceOnly: true})`, paste prompt
 * shown after 3s), so the local browser flow completes with no stdin. On a
 * remote machine where the callback cannot be reached the CLI waits for stdin
 * instead, which is what the timeout and the paste fallback cover.
 */
type SetupTokenProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Command that mints a long-lived token; the user runs it when we cannot. */
export const CLAUDE_SETUP_TOKEN_COMMAND = "claude setup-token";

/** The browser authorization inside the mint can take minutes. */
const CLAUDE_SETUP_TOKEN_TIMEOUT_MS = 180_000;

/** Static tokens carry no local expiry; the far-future value disables Pi's refresh path. */
export const STATIC_CREDENTIAL_EXPIRES = Number.MAX_SAFE_INTEGER;

const ROLES_URL = "https://api.anthropic.com/api/oauth/claude_cli/roles";
const TOKEN_PATTERN = /sk-ant-oat[0-9A-Za-z_-]+/;
/** Anchored twin of TOKEN_PATTERN for values the user submits whole. */
const STATIC_TOKEN_PATTERN = /^sk-ant-oat[0-9A-Za-z_-]+$/;
/** Beta header every OAuth call in this stack sends; the live check must match it. */
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * A credential that never refreshes: Pi's OAuth shape with `refresh` pinned
 * empty and SumoCode's mint date riding along as the classifier for account
 * rows. `expires` stays far-future so Pi's refresh path is never entered.
 */
export type StaticClaudeCredential = OAuthCredential & {
	readonly refresh: "";
	readonly mintedAt: number;
};

export type AcquireResult =
	| { readonly status: "ok"; readonly token: string }
	| { readonly status: "unavailable" }
	| { readonly status: "failed"; readonly reason: string }
	| { readonly status: "timeout" };

export type TokenValidation =
	| { readonly status: "ok"; readonly organization?: string }
	| { readonly status: "rejected" }
	| { readonly status: "unreachable" };

export interface AcquireTokenOptions {
	readonly signal?: AbortSignal;
	/** Called for each new output line so the caller can surface the authorization URL. */
	readonly onProgress?: (line: string) => void;
}

/**
 * True for the token `claude setup-token` prints. Deliberately shape-only: the
 * live check is a separate step so a format error and a rejected credential
 * stay distinguishable to the user.
 */
export function isLongLivedClaudeToken(value: string): boolean {
	return STATIC_TOKEN_PATTERN.test(value.trim());
}

/** Extract the token from `claude setup-token` output (the command wraps it in instructions). */
export function parseSetupTokenOutput(output: string): string | undefined {
	return TOKEN_PATTERN.exec(output)?.[0];
}

/** Spawn the mint command; undefined when the binary cannot be started at all. */
function spawnSetupToken(spawnCommand: typeof spawn): SetupTokenProcess | undefined {
	try {
		return spawnCommand("claude", ["setup-token"], { stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return undefined;
	}
}

/** First http(s) URL in the mint output, so the caller can show where to authorize. */
export function parseAuthorizationUrl(output: string): string | undefined {
	return /https?:\/\/[^\s"'<>]+/.exec(output)?.[0];
}

export function staticClaudeCredential(token: string, mintedAt: number): StaticClaudeCredential {
	return { type: "oauth", access: token, refresh: "", expires: STATIC_CREDENTIAL_EXPIRES, mintedAt };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- credential boundary: the stored value comes back from Pi's credential store as an opaque record.
export function isStaticClaudeCredential(credential: unknown): credential is StaticClaudeCredential {
	if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return false;
	// SAFETY: the typeof check above establishes an object before the property reads.
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
	const value = credential as Record<string, unknown>;
	return (
		value.type === "oauth" &&
		value.refresh === "" &&
		typeof value.access === "string" &&
		value.access.startsWith("sk-ant-oat") &&
		// SumoCode's own marker: a refresh-less oauth credential without it is
		// some other static-token provider's shape, not this flow's credential.
		typeof value.mintedAt === "number"
	);
}

interface AcquireRuntime {
	/** Injection seam for tests; production spawns the real CLI. */
	readonly spawnCommand?: typeof spawn;
	readonly timeoutMs?: number;
}

/**
 * Run `claude setup-token` and capture the token it prints.
 *
 * The CLI prints the token after the browser authorization completes; we
 * resolve as soon as a line carries one instead of waiting for a clean exit,
 * because a slow shell teardown must not lose a token the server already
 * minted.
 */
export function acquireLongLivedToken(
	options: AcquireTokenOptions = {},
	runtime: AcquireRuntime = {},
): Promise<AcquireResult> {
	const spawnCommand = runtime.spawnCommand ?? spawn;
	const timeoutMs = runtime.timeoutMs ?? CLAUDE_SETUP_TOKEN_TIMEOUT_MS;
	return new Promise((resolve) => {
		let settled = false;
		let stdoutOutput = "";
		let stderrOutput = "";
		let stdoutEmitted = 0;
		let stderrEmitted = 0;
		let child: SetupTokenProcess | undefined;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: AcquireResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			child?.kill("SIGTERM");
			resolve(result);
		};
		timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
		const onAbort = (): void => finish({ status: "failed", reason: "cancelled" });
		const consume = (chunk: Buffer | string, isStdout: boolean): void => {
			const output = (isStdout ? stdoutOutput : stderrOutput) + chunk.toString();
			if (isStdout) stdoutOutput = output;
			else stderrOutput = output;
			// Each stream keeps its own buffer and progress cursor: stdout alone is
			// parsed for the token, so stderr bytes can never terminate or extend a
			// partial token, and the streams are never concatenated into one progress
			// line that would carry token bytes to another sink.
			// Only complete stdout lines may be parsed while the child is running: a
			// token split across two writes would otherwise match as a truncated
			// prefix and be stored as a broken credential. The close handler parses
			// the whole stdout buffer, where no further bytes can arrive.
			if (isStdout) {
				const token = parseSetupTokenOutput(output.slice(0, output.lastIndexOf("\n") + 1));
				if (token) {
					finish({ status: "ok", token });
					return;
				}
			}
			if (!options.onProgress) return;
			const flushable = output.slice(0, output.lastIndexOf("\n") + 1);
			const emitted = isStdout ? stdoutEmitted : stderrEmitted;
			if (flushable.length <= emitted) return;
			const lines = flushable.slice(emitted).split("\n").map((line) => line.trim()).filter(Boolean);
			if (isStdout) stdoutEmitted = flushable.length;
			else stderrEmitted = flushable.length;
			for (const line of lines) options.onProgress(line);
		};
		if (options.signal?.aborted) {
			finish({ status: "failed", reason: "cancelled" });
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const spawned = spawnSetupToken(spawnCommand);
		if (!spawned) {
			finish({ status: "unavailable" });
			return;
		}
		child = spawned;
		spawned.on("error", (error: NodeJS.ErrnoException) => {
			finish(error.code === "ENOENT" ? { status: "unavailable" } : { status: "failed", reason: error.message });
		});
		spawned.stdout.on("data", (chunk) => consume(chunk, true));
		spawned.stderr.on("data", (chunk) => consume(chunk, false));
		spawned.on("close", (code) => {
			const token = parseSetupTokenOutput(stdoutOutput);
			if (token) finish({ status: "ok", token });
			else finish({ status: "failed", reason: `claude setup-token exited with code ${code ?? "unknown"}` });
		});
	});
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- untrusted Anthropic response body: the typeof checks below are the sanctioned parse for this I/O boundary.
function organizationName(body: unknown): string | undefined {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof
	if (typeof body !== "object" || body === null) return undefined;
	// SAFETY: the typeof check above establishes an object before the property read.
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion
	const value = (body as Record<string, unknown>).organization_name;
	// oxlint-disable-next-line anti-slop/no-runtime-typeof
	return typeof value === "string" ? value : undefined;
}

export interface ValidateRuntime {
	readonly fetchImpl?: typeof fetch;
	readonly signal?: AbortSignal;
}

/**
 * Confirm the token authenticates before it is stored, and report which
 * account it belongs to. Only an explicit 401 rejects: this endpoint may
 * require a profile scope that an inference-only setup token does not carry, so
 * every other outcome — 403, 404, 5xx, or an unreachable endpoint — warns and
 * proceeds rather than blocking a valid token. Pi's first request is the
 * authoritative check for those.
 */
export async function validateLongLivedToken(token: string, runtime: ValidateRuntime = {}): Promise<TokenValidation> {
	const fetchImpl = runtime.fetchImpl ?? fetch;
	try {
		// Bounded so a hung endpoint cannot hold the flow open; the caller's
		// signal still cancels immediately when the command is torn down.
		const timeout = AbortSignal.timeout(15_000);
		const signal = runtime.signal ? AbortSignal.any([runtime.signal, timeout]) : timeout;
		const response = await fetchImpl(ROLES_URL, {
			headers: { Authorization: `Bearer ${token}`, accept: "application/json", "anthropic-beta": OAUTH_BETA },
			signal,
		});
		if (response.status === 401) return { status: "rejected" };
		if (!response.ok) return { status: "unreachable" };
		const organization = organizationName(await response.json().catch(() => undefined));
		return organization ? { status: "ok", organization } : { status: "ok" };
	} catch {
		return { status: "unreachable" };
	}
}
