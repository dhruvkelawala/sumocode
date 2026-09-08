import { appendFileSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { preflightRecovery } from "../../scripts/plan112-recovery-preflight.mjs";
import { systemProcessTree } from "../../src/background-tasks/process-tree.js";
import { installSubagents } from "../../src/subagents/index.js";
import { RetainedRuntime } from "../../src/subagents/retained-runtime.js";
import { createChildEvidenceContext, requireHarnessAuth, spawnSupervisedProcess, supervisePtyProcess } from "./harness-supervisor.js";
import { cleanupOwnedTree, type OwnedTree } from "./fixtures/subagent-feasibility-cleanup.js";

it("production installer retains a real child across replacement and delivers once", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "production-retention-")));
	const { pi, provider, env } = await preflightRecovery(root);
	const owned: OwnedTree[] = [];
	const managers: ReturnType<typeof installSubagents>[] = [];
	for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
	vi.stubEnv("SUMOCODE_STATE_DIR", join(root, "state"));
	vi.stubEnv("SUMOCODE_CLAUDE_OAUTH_ADAPTER", provider);
	const retention = new RetainedRuntime({ provenance: () => ({ pi, sumocode: pi }), spawnOwner: (command, args, options) => {
		const spawned = spawnSupervisedProcess(command, args, options);
		return spawned.child;
	} });
	const rememberOwned = () => {
		for (const { record } of retention.registry("origin").discover()) {
			for (const birth of [record.supervisor, record.child]) {
				if (!birth || owned.some((tree) => tree.identity.pid === birth.identity.pid)) continue;
				owned.push(birth);
				if (systemProcessTree.identityMatches(birth.identity) === "same") {
					supervisePtyProcess(birth.identity.pid, createChildEvidenceContext([pi, "production-retained"], process.env), process.env, requireHarnessAuth(process.env));
				}
			}
		}
	};
	const install = (session: string) => {
		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<void>>();
		const delivery = vi.fn();
		const api = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler), registerTool: vi.fn(), sendMessage: delivery };
		// SAFETY: the real installer uses this API's registration and message methods with UI disabled.
		const manager = installSubagents(api as never, { retention,
			spawnPiChild: () => { throw new Error("production launch fell back to a disposable child"); },
			terminalHost: { kind: "none", closePane: vi.fn(), openCommandInSplit: vi.fn(), notify: vi.fn() },
		});
		managers.push(manager);
		// SAFETY: noninteractive lifecycle handlers only use these context fields.
		const ctx = { cwd: join(root, "cwd"), isIdle: () => true, hasUI: false, sessionManager: { getSessionId: () => session } } as never;
		// SAFETY: the exercised lifecycle events use only the reason field.
		const fire = (name: string, reason = "startup") => handlers.get(name)!({ reason } as never, ctx);
		return { manager, delivery, fire };
	};
	try {
		const old = install("origin");
		await old.fire("session_start");
		const child = await old.manager.spawn({ cwd: join(root, "cwd"), title: "worker", prompt: "synthetic recovery task",
			appendSystemPrompt: "synthetic private role", builtInTools: [], inherited: { model: { provider: "source-proof", id: "fixed" }, thinking: "off" } });
		if (!("id" in child)) throw new Error("production child was not admitted");
		rememberOwned();
		expect(child).toMatchObject({ status: "running", recovery: "adopted" });
		const before = retention.registry("origin").get(child.id)!;
		await vi.waitFor(() => expect(existsSync(join(root, "provider-called.json"))).toBe(true), { timeout: 15_000 });
		await old.fire("session_shutdown", "new");
		const next = install("successor");
		await next.fire("session_start", "new");
		expect(next.manager.get(child.id)).toMatchObject({ status: "running", recovery: "adopted" });
		expect(retention.registry("origin").get(child.id)?.child).toEqual(before.child);
		writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
		await vi.waitFor(() => expect(next.manager.get(child.id)).toMatchObject({ status: "done", finalText: "preserved result" }), { timeout: 20_000 });
		await old.fire("agent_end");
		await next.fire("agent_end");
		await next.fire("agent_end");
		expect(old.delivery).not.toHaveBeenCalled();
		expect(next.delivery).toHaveBeenCalledOnce();
	} finally {
		rememberOwned();
		for (const manager of managers) manager.detachForReplacement();
		for (const tree of owned.reverse()) expect(await cleanupOwnedTree(systemProcessTree, tree,
			(value) => appendFileSync(join(root, "cleanup.jsonl"), `${JSON.stringify(value)}\n`, { mode: 0o600 }))).toBe(true);
		vi.unstubAllEnvs();
	}
}, 90_000);
