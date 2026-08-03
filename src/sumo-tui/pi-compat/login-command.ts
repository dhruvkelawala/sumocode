import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { authInputTitle } from "./secret-input.js";

export interface RpcLoginRuntime {
	getAvailable(): Promise<readonly unknown[]>;
	getProviders(): readonly Provider[];
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<unknown>;
}

export interface RpcLoginCommandDeps {
	readonly getRuntime?: (ctx: ExtensionCommandContext) => RpcLoginRuntime;
}

type LoginMethod = {
	readonly provider: Provider;
	readonly authType: AuthType;
};

let activeLoginAbort: AbortController | undefined;

const AUTH_LABELS: Readonly<Record<AuthType, string>> = {
	oauth: "Sign in with an account",
	api_key: "Sign in with an API key",
};

function getRuntimeFromContext(ctx: ExtensionCommandContext): RpcLoginRuntime {
	// Pi exposes only the synchronous ModelRegistry compatibility facade to
	// extensions, while its supported login orchestration lives on the paired
	// ModelRuntime. In 0.83.x ModelRegistry retains that runtime as an ordinary
	// `runtime` field. Keep this version-checked private seam isolated here until
	// Pi exposes login through ExtensionContext or RPC directly.
	const runtime = Reflect.get(ctx.modelRegistry, "runtime") as Partial<RpcLoginRuntime> | undefined;
	if (!runtime || typeof runtime.getAvailable !== "function" || typeof runtime.getProviders !== "function" || typeof runtime.login !== "function") {
		throw new Error("Pi's authentication runtime is unavailable; update SumoCode's Pi compatibility adapter");
	}
	return runtime as RpcLoginRuntime;
}

function loginMethods(runtime: RpcLoginRuntime): LoginMethod[] {
	const methods: LoginMethod[] = [];
	for (const provider of runtime.getProviders()) {
		if (provider.auth.oauth) methods.push({ provider, authType: "oauth" });
		if (provider.auth.apiKey) methods.push({ provider, authType: "api_key" });
	}
	return methods.sort((a, b) => a.provider.name.localeCompare(b.provider.name));
}

function authLabel(type: AuthType, methods: readonly LoginMethod[]): string {
	if (type === "oauth") {
		const providerLabel = methods.find((method) => method.authType === type)?.provider.auth.oauth?.loginLabel;
		if (providerLabel) return providerLabel;
	}
	return AUTH_LABELS[type];
}

async function chooseAuthType(ctx: ExtensionCommandContext, methods: readonly LoginMethod[], signal: AbortSignal): Promise<AuthType | undefined> {
	const available = (["oauth", "api_key"] as const).filter((type) => methods.some((method) => method.authType === type));
	if (available.length === 1) return available[0];
	const labels = available.map((type) => authLabel(type, methods));
	const selected = await ctx.ui.select(authInputTitle("Select authentication method:"), labels, { signal });
	return available[labels.indexOf(selected ?? "")];
}

async function chooseProvider(ctx: ExtensionCommandContext, methods: readonly LoginMethod[], signal: AbortSignal): Promise<LoginMethod | undefined> {
	if (methods.length === 0) return undefined;
	if (methods.length === 1) return methods[0];
	const labels = methods.map(({ provider }) => provider.name === provider.id ? provider.id : `${provider.name} (${provider.id})`);
	const selected = await ctx.ui.select(authInputTitle("Select provider:"), labels, { signal });
	const index = labels.indexOf(selected ?? "");
	return index < 0 ? undefined : methods[index];
}

async function resolveLoginMethod(
	args: string,
	ctx: ExtensionCommandContext,
	methods: readonly LoginMethod[],
	signal: AbortSignal,
): Promise<LoginMethod | undefined> {
	const providerRef = args.trim().toLowerCase();
	if (providerRef) {
		const matches = methods.filter(({ provider }) => provider.id.toLowerCase() === providerRef || provider.name.toLowerCase() === providerRef);
		if (matches.length === 0) {
			ctx.ui.notify(`Unknown login provider: ${args.trim()}`, "warning");
			return undefined;
		}
		const authType = await chooseAuthType(ctx, matches, signal);
		return matches.find((method) => method.authType === authType);
	}
	const authType = await chooseAuthType(ctx, methods, signal);
	if (!authType) return undefined;
	return chooseProvider(ctx, methods.filter((method) => method.authType === authType), signal);
}

function cancelled(): Error {
	return new Error("Login cancelled");
}

async function showPrompt(ctx: ExtensionCommandContext, prompt: AuthPrompt, loginSignal: AbortSignal): Promise<string> {
	const promptAbort = new AbortController();
	const signals = prompt.signal ? [loginSignal, prompt.signal] : [loginSignal];
	const abortPrompt = () => promptAbort.abort();
	for (const signal of signals) {
		if (signal.aborted) promptAbort.abort();
		else signal.addEventListener("abort", abortPrompt, { once: true });
	}
	try {
		if (prompt.type === "select") {
			const labels = prompt.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
			const title = authInputTitle(prompt.message);
			const selected = await ctx.ui.select(title, labels, { signal: promptAbort.signal });
			const index = labels.indexOf(selected ?? "");
			const option = prompt.options[index];
			if (!option) throw cancelled();
			return option.id;
		}
		const title = authInputTitle(prompt.message, prompt.type === "secret");
		const value = await ctx.ui.input(title, prompt.placeholder, { signal: promptAbort.signal });
		if (value === undefined) throw cancelled();
		return value;
	} finally {
		for (const signal of signals) signal.removeEventListener("abort", abortPrompt);
	}
}

function publishLoginDetails(ctx: ExtensionCommandContext, lines: readonly string[]): void {
	ctx.ui.setWidget("sumocode.login", [...lines], { placement: "aboveEditor" });
	ctx.ui.notify(lines.join("\n"), "info");
}

function showEvent(ctx: ExtensionCommandContext, event: AuthEvent): void {
	switch (event.type) {
		case "auth_url":
			publishLoginDetails(ctx, [event.instructions ?? "Open this URL to continue:", event.url]);
			return;
		case "device_code":
			publishLoginDetails(ctx, [`Open ${event.verificationUri}`, `Code: ${event.userCode}`]);
			return;
		case "info": {
			const links = event.links?.map((link) => `${link.label ? `${link.label}: ` : ""}${link.url}`) ?? [];
			publishLoginDetails(ctx, [event.message, ...links]);
			return;
		}
		case "progress":
			ctx.ui.setStatus("sumocode.login", event.message);
	}
}

export async function executeRpcLogin(args: string, ctx: ExtensionCommandContext, runtime: RpcLoginRuntime): Promise<void> {
	if (ctx.mode !== "rpc" || !ctx.hasUI) {
		ctx.ui.notify("/login compatibility command requires SumoCode RPC mode", "warning");
		return;
	}
	if (activeLoginAbort) {
		ctx.ui.notify("A login is already in progress", "warning");
		return;
	}
	const loginAbort = new AbortController();
	activeLoginAbort = loginAbort;
	try {
		await runtime.getAvailable();
		if (loginAbort.signal.aborted) throw cancelled();
		const methods = loginMethods(runtime);
		if (methods.length === 0) {
			ctx.ui.notify("No login providers available", "warning");
			return;
		}
		const method = await resolveLoginMethod(args, ctx, methods, loginAbort.signal);
		if (!method || loginAbort.signal.aborted) return;
		const apiKeyMethod = method.provider.auth.apiKey;
		if (method.authType === "api_key" && !apiKeyMethod?.login) {
			ctx.ui.notify(`${apiKeyMethod?.name ?? method.provider.name} is configured outside Pi`, "info");
			return;
		}
		await runtime.login(method.provider.id, method.authType, {
			signal: loginAbort.signal,
			prompt: (prompt) => showPrompt(ctx, prompt, loginAbort.signal),
			notify: (event) => showEvent(ctx, event),
		});
		ctx.ui.notify(`Logged in to ${method.provider.name}`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message !== "Login cancelled") ctx.ui.notify(`Login failed: ${message}`, "error");
	} finally {
		loginAbort.abort();
		if (activeLoginAbort === loginAbort) activeLoginAbort = undefined;
		ctx.ui.setStatus("sumocode.login", undefined);
		ctx.ui.setWidget("sumocode.login", undefined);
	}
}

export function cancelActiveRpcLogin(): boolean {
	if (!activeLoginAbort) return false;
	activeLoginAbort.abort();
	return true;
}

export function registerRpcLoginCommand(pi: ExtensionAPI, deps: RpcLoginCommandDeps = {}): void {
	const getRuntime = deps.getRuntime ?? getRuntimeFromContext;
	pi.registerCommand("login", {
		description: "Configure provider authentication",
		handler: async (args, ctx) => executeRpcLogin(args, ctx, getRuntime(ctx)),
	});
	pi.registerCommand("sumo:login-cancel", {
		description: "Cancel the active SumoCode authentication flow",
		handler: async (_args, ctx) => {
			if (cancelActiveRpcLogin()) ctx.ui.notify("Login cancelled", "info");
		},
	});
}
