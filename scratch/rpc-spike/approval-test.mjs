import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcProcess, repoRoot } from "./rpc-process.mjs";

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function runCase(answer) {
	const tmp = await mkdtemp(join(tmpdir(), "sumocode-rpc-approval-"));
	const sentinel = join(tmp, "sentinel.txt");
	await import("node:fs/promises").then(({ writeFile }) => writeFile(sentinel, "do-not-delete", "utf8"));
	const events = [];
	const rpc = new RpcProcess({
		cwd: repoRoot,
		extensions: ["scratch/rpc-spike/approval-extension.mjs"],
	});
	rpc.onEvent((event) => events.push(event));
	rpc.setUiRequestHandler((request, instance) => {
		if (request.method === "select") {
			if (answer === undefined) return;
			instance.sendUiResponse({ type: "extension_ui_response", id: request.id, value: answer });
		}
	});
	try {
		await rpc.send({ type: "set_model", provider: "sumocode-rpc-spike", modelId: "deterministic" }, { timeoutMs: 10_000 });
		const response = await rpc.send({
			type: "prompt",
			message: `RPC_APPROVAL_SENTINEL=${sentinel}\nCall the bash tool exactly as requested.`,
		}, { timeoutMs: 10_000 });
		await rpc.waitFor((event) => event.type === "agent_end", { timeoutMs: 20_000, label: `agent_end ${answer ?? "timeout"}` });
		const started = events.some((event) => event.type === "tool_execution_start" && event.toolName === "bash");
		const ended = events.some((event) => event.type === "tool_execution_end" && event.toolName === "bash" && event.isError === false);
		const stillExists = await exists(sentinel);
		return { answer: answer ?? "timeout", response, started, ended, sentinelExists: stillExists };
	} finally {
		await rpc.dispose();
		await rm(tmp, { recursive: true, force: true });
	}
}

const denied = await runCase("No");
if (!denied.started || denied.ended || !denied.sentinelExists || denied.response.success !== true) {
	console.error(JSON.stringify({ ok: false, case: "No", denied }, null, 2));
	process.exit(1);
}

const timeout = await runCase(undefined);
if (!timeout.started || timeout.ended || !timeout.sentinelExists || timeout.response.success !== true) {
	console.error(JSON.stringify({ ok: false, case: "timeout", timeout }, null, 2));
	process.exit(1);
}

const allowed = await runCase("Yes");
if (!allowed.started || allowed.sentinelExists || allowed.response.success !== true) {
	console.error(JSON.stringify({ ok: false, case: "Yes", allowed }, null, 2));
	process.exit(1);
}

console.log(JSON.stringify({ ok: true, denied, timeout, allowed }, null, 2));
