import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cancelActiveRpcLogin, executeRpcLogin, redactLoginErrorText, registerRpcLoginCommand, type RpcLoginRuntime } from "./login-command.js";
import { decodeAuthInputTitle, isSecretInputTitle } from "./secret-input.js";
/* oxlint-disable anti-slop/no-chained-type-assertions -- test doubles cast minimal stub objects to Pi context types. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- stub shape is exercised by the assertions below. */

function provider(options: { oauth?: boolean; apiKey?: boolean } = { oauth: true }) {
	return {
		id: "anthropic",
		name: "Anthropic",
		auth: {
			...(options.oauth && { oauth: {} }),
			...(options.apiKey && { apiKey: { name: "Anthropic API key", login: vi.fn() } }),
		},
	};
}

function context(options: { selections?: string[]; inputs?: string[] } = {}) {
	const selections = [...(options.selections ?? [])];
	const inputs = [...(options.inputs ?? [])];
	return {
		mode: "rpc",
		hasUI: true,
		ui: {
			select: vi.fn(async () => selections.shift()),
			input: vi.fn(async () => inputs.shift()),
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
}

function runtimeFor(providerValue = provider()): RpcLoginRuntime {
	return {
		getAvailable: vi.fn(async () => []),
		getProviders: vi.fn(() => [providerValue] as never),
		login: vi.fn(async (_providerId, _type, interaction) => {
			interaction.notify({ type: "auth_url", url: "https://auth.example/login", instructions: "Open this URL" });
			const code = await interaction.prompt({ type: "manual_code", message: "Paste authorization code" });
			expect(code).toBe("oauth-code");
			return { type: "oauth" } as never;
		}),
	};
}

describe("RPC /login compatibility command", () => {
	it("registers /login so Pi RPC get_commands can expose it", () => {
		const registerCommand = vi.fn();
		registerRpcLoginCommand({ registerCommand } as unknown as ExtensionAPI, {
			getRuntime: vi.fn(),
		});

		expect(registerCommand).toHaveBeenCalledWith("login", expect.objectContaining({
			description: "Configure provider authentication",
		}));
	});

	it("runs Pi's OAuth flow for an explicit provider through RPC UI prompts", async () => {
		const ctx = context({ inputs: ["oauth-code"] });
		const runtime = runtimeFor();

		await executeRpcLogin("anthropic", ctx, runtime);

		expect(runtime.login).toHaveBeenCalledWith("anthropic", "oauth", expect.any(Object));
		const promptTitle = (ctx.ui.input as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
		expect(decodeAuthInputTitle(promptTitle)).toEqual({ title: "Paste authorization code", auth: true, secret: false });
		expect(ctx.ui.notify).toHaveBeenCalledWith("Open this URL\nhttps://auth.example/login", "info");
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("sumocode.login", ["Open this URL", "https://auth.example/login"], { placement: "aboveEditor" });
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("sumocode.login", undefined);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Logged in to Anthropic", "info");
	});

	it("reports when Pi exposes no login providers", async () => {
		const ctx = context();
		const runtime = runtimeFor();
		(runtime.getProviders as ReturnType<typeof vi.fn>).mockReturnValue([]);

		await executeRpcLogin("", ctx, runtime);

		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("No login providers available", "warning");
	});

	it("honors cancellation that arrives during provider discovery", async () => {
		const ctx = context();
		const runtime = runtimeFor();
		let finishDiscovery!: () => void;
		(runtime.getAvailable as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((resolve) => {
			finishDiscovery = () => resolve([]);
		}));

		const login = executeRpcLogin("anthropic", ctx, runtime);
		await vi.waitFor(() => expect(runtime.getAvailable).toHaveBeenCalled());
		expect(cancelActiveRpcLogin()).toBe(true);
		finishDiscovery();
		await login;

		expect(runtime.login).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "authentication-method",
			args: "anthropic",
			providers: [provider({ oauth: true, apiKey: true })],
			title: "Select authentication method:",
		},
		{
			name: "provider",
			args: "",
			providers: [provider(), { ...provider(), id: "openai", name: "OpenAI" }],
			title: "Select provider:",
		},
	])("cancels the $name selector through the shared login signal", async ({ args, providers, title }) => {
		const ctx = context();
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (_title, _options, selectOptions) => {
			return new Promise<undefined>((resolve) => {
				(selectOptions?.signal as AbortSignal | undefined)?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		});
		const runtime = runtimeFor();
		(runtime.getProviders as ReturnType<typeof vi.fn>).mockReturnValue(providers as never);

		const login = executeRpcLogin(args, ctx, runtime);
		await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled());
		const [encodedTitle, , options] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
		expect(decodeAuthInputTitle(encodedTitle as string)).toEqual({ title, auth: true, secret: false });
		expect(options).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(cancelActiveRpcLogin()).toBe(true);
		await login;

		expect(runtime.login).not.toHaveBeenCalled();
		expect(cancelActiveRpcLogin()).toBe(false);
	});

	it("cancels promptless login flows through the shared authentication signal", async () => {
		const ctx = context();
		const runtime = runtimeFor();
		(runtime.login as ReturnType<typeof vi.fn>).mockImplementation(async (_providerId, _type, interaction) => {
			await new Promise<void>((_resolve, reject) => {
				interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
			});
			return {} as never;
		});

		const login = executeRpcLogin("anthropic", ctx, runtime);
		await vi.waitFor(() => expect(runtime.login).toHaveBeenCalled());
		expect(cancelActiveRpcLogin()).toBe(true);
		await login;

		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Login failed"), "error");
	});

	it("does not report a provider-specific abort error after cancellation", async () => {
		const ctx = context();
		const runtime = runtimeFor();
		(runtime.login as ReturnType<typeof vi.fn>).mockImplementation(async (_providerId, _type, interaction) => {
			return new Promise((_resolve, reject) => {
				interaction.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
			});
		});

		const login = executeRpcLogin("anthropic", ctx, runtime);
		await vi.waitFor(() => expect(runtime.login).toHaveBeenCalled());
		expect(cancelActiveRpcLogin()).toBe(true);
		await login;

		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Login failed"), "error");
	});

	it("cancels an authentication prompt that omits its own signal", async () => {
		const ctx = context();
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockImplementation(async (_title, _placeholder, options) => {
			return new Promise<undefined>((resolve) => {
				(options?.signal as AbortSignal | undefined)?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		});
		const runtime = runtimeFor();
		(runtime.login as ReturnType<typeof vi.fn>).mockImplementation(async (_providerId, _type, interaction) => {
			await interaction.prompt({ type: "manual_code", message: "Paste authorization code" });
			return {} as never;
		});

		const login = executeRpcLogin("anthropic", ctx, runtime);
		await vi.waitFor(() => expect(ctx.ui.input).toHaveBeenCalled());
		expect(cancelActiveRpcLogin()).toBe(true);
		await login;

		expect(ctx.ui.input).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Login failed"), "error");
	});

	it("marks API-key prompts as secret on the SumoCode RPC wire", async () => {
		const apiKeyProvider = provider({ oauth: false, apiKey: true });
		const ctx = context({ inputs: ["sk-secret"] });
		const runtime = runtimeFor(apiKeyProvider);
		(runtime.login as ReturnType<typeof vi.fn>).mockImplementation(async (_providerId, _type, interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter API key", placeholder: "sk-..." });
			expect(key).toBe("sk-secret");
			return { type: "api_key" } as never;
		});

		await executeRpcLogin("anthropic", ctx, runtime);

		const title = (ctx.ui.input as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
		expect(isSecretInputTitle(title)).toBe(true);
		expect(title).not.toContain("sk-secret");
	});
});

describe("redactLoginErrorText", () => {
	it("redacts credential-bearing URL query values", () => {
		const input = "request to https://console.anthropic.com/v1/oauth/callback?code=abc-secret-123&state=s1 failed";
		expect(redactLoginErrorText(input)).toBe(
			"request to https://console.anthropic.com/v1/oauth/callback?code=[redacted]&state=[redacted] failed",
		);
	});

	it("redacts bearer tokens and sk- keys", () => {
		expect(redactLoginErrorText("auth failed for Bearer sk-ant-abcdef123456789")).toBe("auth failed for Bearer [redacted]");
		expect(redactLoginErrorText("bad key sk-abcdef1234567890")).toBe("bad key [redacted]");
	});

	it("leaves ordinary error text untouched", () => {
		const input = "Unknown login provider: anthropic-2";
		expect(redactLoginErrorText(input)).toBe(input);
	});
});
