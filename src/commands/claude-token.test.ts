import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles cast minimal stubs to the node child_process and fetch types the production seams accept; each stub implements every member the module reads. */
import {
	CLAUDE_SETUP_TOKEN_COMMAND,
	acquireLongLivedToken,
	isLongLivedClaudeToken,
	isStaticClaudeCredential,
	parseAuthorizationUrl,
	parseSetupTokenOutput,
	staticClaudeCredential,
	validateLongLivedToken,
} from "./claude-token.js";

const VALID_TOKEN = "sk-ant-oat01-AbCdEf0123456789_-xyz";

class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly kill = vi.fn();
	emitStdout(chunk: string): void {
		this.stdout.emit("data", Buffer.from(chunk, "utf8"));
	}
}

function fakeSpawn(child: FakeChild) {
	return vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
}

describe("CLAUDE_SETUP_TOKEN_COMMAND", () => {
	it("names the mint command shown to the user", () => {
		expect(CLAUDE_SETUP_TOKEN_COMMAND).toBe("claude setup-token");
	});
});

describe("isLongLivedClaudeToken", () => {
	it("accepts the setup-token shape", () => {
		expect(isLongLivedClaudeToken(VALID_TOKEN)).toBe(true);
	});

	it("accepts surrounding whitespace", () => {
		expect(isLongLivedClaudeToken(`  ${VALID_TOKEN}\n`)).toBe(true);
	});

	it("rejects an API key, an empty value, and trailing prose", () => {
		expect(isLongLivedClaudeToken("sk-ant-api03-abc")).toBe(false);
		expect(isLongLivedClaudeToken("")).toBe(false);
		expect(isLongLivedClaudeToken(`${VALID_TOKEN} extra`)).toBe(false);
	});
});

describe("parseSetupTokenOutput", () => {
	it("extracts the token from the command's instructions", () => {
		const output = `Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=${VALID_TOKEN}\n`;
		expect(parseSetupTokenOutput(output)).toBe(VALID_TOKEN);
	});

	it("returns undefined when the output carries no token", () => {
		expect(parseSetupTokenOutput("Opening browser…\n")).toBeUndefined();
	});
});

describe("parseAuthorizationUrl", () => {
	it("finds the authorization URL in the mint output", () => {
		const output = "Open https://claude.ai/oauth/authorize?code=true&client_id=x to continue";
		expect(parseAuthorizationUrl(output)).toBe("https://claude.ai/oauth/authorize?code=true&client_id=x");
	});

	it("returns undefined when no URL is present", () => {
		expect(parseAuthorizationUrl("waiting…")).toBeUndefined();
	});
});

describe("staticClaudeCredential", () => {
	it("stores a static oauth credential that never enters Pi's refresh path", () => {
		const credential = staticClaudeCredential(VALID_TOKEN, 1_700_000_000_000);
		expect(credential).toEqual({
			type: "oauth",
			access: VALID_TOKEN,
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
			mintedAt: 1_700_000_000_000,
		});
	});

	it("is recognised by the reader used for account rows", () => {
		expect(isStaticClaudeCredential(staticClaudeCredential(VALID_TOKEN, 0))).toBe(true);
		expect(isStaticClaudeCredential({ type: "oauth", access: "x", refresh: "sk-ant-ort01-y" })).toBe(false);
		expect(isStaticClaudeCredential({ type: "api_key", key: "x" })).toBe(false);
		expect(isStaticClaudeCredential(undefined)).toBe(false);
	});
});

describe("acquireLongLivedToken", () => {
	it("resolves with the token the command prints", async () => {
		const child = new FakeChild();
		const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child) });
		child.emitStdout(`export CLAUDE_CODE_OAUTH_TOKEN=${VALID_TOKEN}\n`);
		await expect(promise).resolves.toEqual({ status: "ok", token: VALID_TOKEN });
		expect(child.kill).toHaveBeenCalled();
	});

	it("reports the authorization URL while waiting", async () => {
		const child = new FakeChild();
		const onProgress = vi.fn();
		const promise = acquireLongLivedToken({ onProgress }, { spawnCommand: fakeSpawn(child) });
		child.emitStdout("Open https://claude.ai/oauth/authorize?code=true\n");
		child.emitStdout(`export CLAUDE_CODE_OAUTH_TOKEN=${VALID_TOKEN}\n`);
		await promise;
		expect(onProgress).toHaveBeenCalledWith("Open https://claude.ai/oauth/authorize?code=true");
	});

	it("does not capture a token that is still split across writes", async () => {
		const child = new FakeChild();
		const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child) });
		child.emitStdout("export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbCdEf");
		let settled = false;
		void promise.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		child.emitStdout("0123456789_-xyz\n");
		await expect(promise).resolves.toEqual({ status: "ok", token: VALID_TOKEN });
	});

	it("does not let a stderr newline terminate a token split across stdout writes", async () => {
		const child = new FakeChild();
		const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child) });
		child.emitStdout("export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbCdEf");
		child.stderr.emit("data", Buffer.from("\n", "utf8"));
		child.emitStdout("0123456789_-xyz\n");
		await expect(promise).resolves.toEqual({ status: "ok", token: VALID_TOKEN });
	});

	it("does not let stderr text extend a token split across stdout writes", async () => {
		const child = new FakeChild();
		const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child) });
		child.emitStdout("export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbCdEf");
		child.stderr.emit("data", Buffer.from("warning: slow down\n", "utf8"));
		child.emitStdout("0123456789_-xyz\n");
		await expect(promise).resolves.toEqual({ status: "ok", token: VALID_TOKEN });
	});

	it("never forwards a partially written token line to onProgress", async () => {
		const child = new FakeChild();
		const onProgress = vi.fn();
		const promise = acquireLongLivedToken({ onProgress }, { spawnCommand: fakeSpawn(child) });
		child.emitStdout("export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbCdEf");
		child.stderr.emit("data", Buffer.from("warning: slow down\n", "utf8"));
		child.emitStdout("0123456789_-xyz\n");
		await expect(promise).resolves.toEqual({ status: "ok", token: VALID_TOKEN });
		expect(onProgress.mock.calls.map(([line]) => line).join("\n")).not.toContain("sk-ant-oat01");
	});

	it("captures a token that arrives without a trailing newline before exit", async () => {
		const child = new FakeChild();
		const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child) });
		child.emitStdout(`Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=${VALID_TOKEN}`);
		child.emit("close", 0);
		await expect(promise).resolves.toEqual({ status: "ok", token: VALID_TOKEN });
	});

	it("reports the CLI as unavailable when the binary is missing", async () => {
		const child = new FakeChild();
		const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child) });
		const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
		child.emit("error", error);
		await expect(promise).resolves.toEqual({ status: "unavailable" });
	});

	it("fails when the command exits without printing a token", async () => {
		const child = new FakeChild();
		const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child) });
		child.emitStdout("browser closed\n");
		child.emit("close", 1);
		await expect(promise).resolves.toEqual({ status: "failed", reason: "claude setup-token exited with code 1" });
	});

	it("times out when the user never finishes authorization", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			const promise = acquireLongLivedToken({}, { spawnCommand: fakeSpawn(child), timeoutMs: 1000 });
			await vi.advanceTimersByTimeAsync(1000);
			await expect(promise).resolves.toEqual({ status: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels when the caller aborts", async () => {
		const child = new FakeChild();
		const controller = new AbortController();
		const promise = acquireLongLivedToken({ signal: controller.signal }, { spawnCommand: fakeSpawn(child) });
		controller.abort();
		await expect(promise).resolves.toEqual({ status: "failed", reason: "cancelled" });
	});
});

describe("validateLongLivedToken", () => {
	function fetchReturning(response: Response | Error) {
		return vi.fn(async () => {
			if (response instanceof Error) throw response;
			return response;
		}) as unknown as typeof fetch;
	}

	it("reports the organization the token belongs to", async () => {
		const body = JSON.stringify({ organization_name: "Example Org" });
		const fetchImpl = fetchReturning(new Response(body, { status: 200 }));
		await expect(validateLongLivedToken(VALID_TOKEN, { fetchImpl })).resolves.toEqual({
			status: "ok",
			organization: "Example Org",
		});
	});

	it("rejects a credential the server does not accept", async () => {
		const fetchImpl = fetchReturning(new Response("{}", { status: 401 }));
		await expect(validateLongLivedToken(VALID_TOKEN, { fetchImpl })).resolves.toEqual({ status: "rejected" });
	});

	it("does not reject on a 403, because an inference-only token may lack scope", async () => {
		const fetchImpl = fetchReturning(new Response("{}", { status: 403 }));
		await expect(validateLongLivedToken(VALID_TOKEN, { fetchImpl })).resolves.toEqual({ status: "unreachable" });
	});

	it("reports an unreachable endpoint instead of failing the flow", async () => {
		const fetchImpl = fetchReturning(new TypeError("network down"));
		await expect(validateLongLivedToken(VALID_TOKEN, { fetchImpl })).resolves.toEqual({ status: "unreachable" });
	});
});
