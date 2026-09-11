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
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this module parses two untrusted external shapes (the setup-token CLI's output and Anthropic's roles response) and reads a stored credential back from auth.json; the typeof checks at each boundary are the sanctioned parse.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** The mint child with piped stdout/stderr and no stdin (the command must not wait on input). */
type SetupTokenProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Command that mints a long-lived token; the user runs it when we cannot. */
export const CLAUDE_SETUP_TOKEN_COMMAND = "claude setup-token";

/** The browser authorization inside the mint can take minutes. */
const CLAUDE_SETUP_TOKEN_TIMEOUT_MS = 180_000;

/** Static tokens carry no local expiry; the far-future value disables Pi's refresh path. */
export const STATIC_CREDENTIAL_EXPIRES = Number.MAX_SAFE_INTEGER;

const ROLES_URL = "https://api.anthropic.com/api/oauth/claude_cli/roles";
const TOKEN_PATTERN = /sk-ant-oat[0-9A-Za-z_-]+/;

/** The credential Pi stores for a long-lived token. `mintedAt` is SumoCode's own advisory field. */
export interface StaticClaudeCredential {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: "";
	readonly expires: number;
	readonly mintedAt: number;
}

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
	return TOKEN_PATTERN.test(value.trim()) && value.trim().match(TOKEN_PATTERN)?.[0] === value.trim();
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- credential boundary: the stored value is untrusted JSON read back from auth.json.
export function isStaticClaudeCredential(credential: unknown): credential is StaticClaudeCredential {
	if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return false;
	const value = credential as Record<string, unknown>;
	return value.type === "oauth" && typeof value.access === "string" && value.refresh === "";
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
		let output = "";
		let emitted = 0;
		let child: SetupTokenProcess | undefined;
		const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
		const finish = (result: AcquireResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			child?.kill("SIGTERM");
			resolve(result);
		};
		const onAbort = (): void => finish({ status: "failed", reason: "cancelled" });
		const consume = (chunk: Buffer | string): void => {
			output += chunk.toString();
			const token = parseSetupTokenOutput(output);
			if (token) {
				finish({ status: "ok", token });
				return;
			}
			const newline = output.lastIndexOf("\n");
			if (newline < emitted || !options.onProgress) return;
			const lines = output.slice(emitted, newline).split("\n").map((line) => line.trim()).filter(Boolean);
			emitted = newline + 1;
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
		spawned.stdout.on("data", consume);
		spawned.stderr.on("data", consume);
		spawned.on("close", (code) => {
			const token = parseSetupTokenOutput(output);
			if (token) finish({ status: "ok", token });
			else finish({ status: "failed", reason: `claude setup-token exited with code ${code ?? "unknown"}` });
		});
	});
}

interface ValidateRuntime {
	readonly fetchImpl?: typeof fetch;
	readonly signal?: AbortSignal;
}

/**
 * Confirm the token authenticates before it is stored, and report which
 * account it belongs to. Only an explicit 401 rejects: a 403 or an unreachable
 * endpoint must not block a valid inference-only token.
 */
export async function validateLongLivedToken(token: string, runtime: ValidateRuntime = {}): Promise<TokenValidation> {
	const fetchImpl = runtime.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(ROLES_URL, {
			headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
			signal: runtime.signal,
		});
		if (response.status === 401) return { status: "rejected" };
		if (!response.ok) return { status: "unreachable" };
		const body: unknown = await response.json().catch(() => undefined);
		const organization =
			typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).organization_name === "string"
				? ((body as Record<string, unknown>).organization_name as string)
				: undefined;
		return organization ? { status: "ok", organization } : { status: "ok" };
	} catch {
		return { status: "unreachable" };
	}
}
