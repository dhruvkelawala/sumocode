import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";

const ENTER = "\x1b[13u";
const COLS = 100;
const ROWS = 30;
let app: SpawnedPiPty | undefined;
let jev: Server | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
	await new Promise((resolve) => jev ? jev.close(resolve) : resolve(undefined));
	jev = undefined;
});

interface LoggedPrompt {
	readonly type: string;
	readonly message?: string;
	readonly streamingBehavior?: string;
}

interface JevRequest {
	readonly authorization?: string;
	readonly state: { readonly current_task?: string; readonly message: string };
}

async function prompts(path: string): Promise<LoggedPrompt[]> {
	try {
		// SAFETY: the isolated fixture writes one JSON command object per line.
		return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LoggedPrompt)
			.filter((command) => command.type === "prompt");
	} catch {
		return [];
	}
}

async function waitForPrompts(path: string, count: number): Promise<LoggedPrompt[]> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const logged = await prompts(path);
		if (logged.length >= count) return logged;
		// WAIT-CLASS: poll-interval — bounded gap between command-log observations.
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return prompts(path);
}

async function readBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += String(chunk);
	return body;
}

/** A local stand-in for TypeSafe's System One API: follow-up for "after that…", 500 for "explode", steer otherwise. */
async function startFakeJev(requests: JevRequest[]): Promise<string> {
	const server = createServer(async (request, response) => {
		// SAFETY: SumoCode's TypeSafe client is the only caller and always posts JSON.
		const body = JSON.parse(await readBody(request)) as { readonly state: JevRequest["state"] };
		requests.push({ authorization: request.headers.authorization, state: body.state });
		if (body.state.message.includes("explode")) {
			response.writeHead(500).end();
			return;
		}
		const choice = body.state.message.startsWith("after that") ? "follow_up" : "steer";
		response.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ answers: { answer: { type: "choice", choice, confidence: 0.95 } } }));
	});
	jev = server;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

async function boot(prefix: string, env: NodeJS.ProcessEnv): Promise<{ readonly logPath: string; readonly app: SpawnedPiPty }> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const logPath = join(dir, "commands.jsonl");
	const piBin = await createRpcChildFixture(`${prefix}child-`, { promptDelayMs: 5_000 });
	const spawned = spawnSumocodePty({
		env: { PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), `${prefix}agent-`)), PI_BIN: piBin, SUMOCODE_RPC_FIXTURE_LOG: logPath, ...env },
		cols: COLS,
		rows: ROWS,
	});
	await spawned.waitForReady("app", 15_000);
	return { logPath, app: spawned };
}

describe("RPC /queue auto", () => {
	it("lets Jev pick each busy message's delivery, with the run's prompt as context", async () => {
		const requests: JevRequest[] = [];
		const baseUrl = await startFakeJev(requests);
		const booted = await boot("sumocode-queue-auto-", { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: baseUrl });
		app = booted.app;

		app.sendInput(`/queue auto${ENTER}`);
		await waitForScreen(app, (screen) => screen.text.includes("Queue mode: auto"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });
		app.sendInput(`prompt A${ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`after that, open a PR${ENTER}`);
		app.sendInput(`use a Map instead${ENTER}`);
		app.sendInput(`explode${ENTER}`);
		await waitForScreen(app, (screen) => screen.text.includes("FOLLOW-UP (1)") && screen.text.includes("STEERING (2)"), {
			cols: COLS, rows: ROWS, timeoutMs: 5_000,
		});

		expect(await waitForPrompts(booted.logPath, 4)).toMatchObject([
			{ message: "prompt A", streamingBehavior: "steer" },
			{ message: "after that, open a PR", streamingBehavior: "followUp" },
			{ message: "use a Map instead", streamingBehavior: "steer" },
			{ message: "explode", streamingBehavior: "steer" },
		]);
		// The idle prompt and the /queue command never reach Jev; every busy message does, in order.
		expect(requests).toEqual([
			{ authorization: "Bearer test-key", state: { current_task: "prompt A", message: "after that, open a PR" } },
			{ authorization: "Bearer test-key", state: { current_task: "prompt A", message: "use a Map instead" } },
			{ authorization: "Bearer test-key", state: { current_task: "prompt A", message: "explode" } },
		]);
	}, 30_000);

	it("warns without TYPESAFE_API_KEY and keeps steering", async () => {
		const booted = await boot("sumocode-queue-auto-keyless-", {});
		app = booted.app;

		app.sendInput(`/queue auto${ENTER}`);
		await waitForScreen(app, (screen) => screen.text.includes("auto needs TYPESAFE_API_KEY · steering"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });
		app.sendInput(`prompt A${ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`after that, open a PR${ENTER}`);
		await waitForScreen(app, (screen) => screen.text.includes("STEERING (1)"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });

		expect(await waitForPrompts(booted.logPath, 2)).toMatchObject([
			{ message: "prompt A", streamingBehavior: "steer" },
			{ message: "after that, open a PR", streamingBehavior: "steer" },
		]);
	}, 30_000);
});
