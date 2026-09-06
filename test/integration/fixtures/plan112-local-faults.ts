import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentSnapshot } from "../../../src/subagents/domain.js";
import type { SubagentRegistry, SubagentRecord } from "../../../src/subagents/registry.js";
import { controlAuthority } from "../../../src/subagents/retained-adoption.js";
import type { RetainedHeadlessSupervisor } from "../../../src/subagents/retained-supervisor.js";
import type { install } from "./plan112-source-controller.js";

/** Real Pi/parser and disk; only the ExtensionAPI recipient is a test recorder. */
export async function runLocalFault(root: string, scenario: string, registry: SubagentRegistry,
	owner: RetainedHeadlessSupervisor, initial: SubagentRecord, create: typeof install): Promise<void> {
	const old = create("origin");
	const next = create("successor");
	const current = owner.record;
	const granted = registry.acquireControl(current.id, current.revision, current.writerLease!.generation, current.controlHead, old.manager.controllerIdentity, 60_000);
	const authority = controlAuthority(granted);
	const snapshot: SubagentSnapshot = { id: initial.id, title: "worker", prompt: "synthetic recovery task", cwd: join(root, "cwd"), baseRef: "HEAD",
		status: "running", createdAt: initial.createdAt, visible: false, usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" };
	const artifacts = () => ["result.json", "manifest.json"].map((name) => readFileSync(join(initial.taskDir, name), "utf8"));
	const finish = async () => {
		writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
		assert.equal(await owner.settlement, "settled");
	};
	try {
		await old.manager.trackRetained({ registry: registry.forController(old.manager.controllerIdentity), supervisor: owner, snapshot, authority });
		const action = scenario.startsWith("race:") ? scenario.slice(5) : undefined;
		const uncertain = scenario.startsWith("delivery:");
		const before = scenario === "settle-before" || scenario === "corrupt" || action !== undefined || uncertain;
		if (before) await finish();
		const saved = before ? artifacts() : undefined;
		if (uncertain) {
			const hold = () => {
				writeFileSync(join(root, "cut-ready.json"), JSON.stringify({ submissions: old.deliveries.length }), { mode: 0o600, flag: "wx" });
				while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			};
			if (scenario === "delivery:send-before-ack") { old.afterSend(hold); await old.fire("agent_end"); }
			else { registry.forController(old.manager.controllerIdentity).advanceDelivery(owner.record.revision, authority, "send"); hold(); }
			throw new Error("delivery cut returned");
		}
		if (action) {
			const result = await old.tools.get(`subagent_${action}`)!.execute("call", action === "check" ? { id: initial.id } : { ids: [initial.id] });
			assert.notEqual(result.details, undefined);
		}
		if (scenario === "corrupt") writeFileSync(join(root, "registry", `${initial.id}.json`), "{broken", { mode: 0o600 });
		const reason = scenario.startsWith("handoff:") ? scenario.slice(8) : "new";
		await old.fire("session_shutdown", reason);
		await next.fire("session_start", reason);
		if (scenario === "corrupt") {
			assert.notEqual(next.manager.get(initial.id)?.recovery, "adopted");
			await next.manager.cancel([initial.id]);
			await next.manager.close([initial.id]);
			await assert.rejects(next.manager.sendTo(initial.id, "forbidden"));
			await next.fire("agent_end");
			assert.equal(next.deliveries.length, 0);
			assert.equal(readFileSync(join(root, "registry", `${initial.id}.json`), "utf8"), "{broken");
			assert.deepEqual(artifacts(), saved);
			return;
		}
		assert.equal(registry.inspectControl(authority), false);
		assert.equal(next.manager.get(initial.id)?.recovery, "adopted");
		assert.deepEqual(owner.record.child, current.child);
		assert.deepEqual(owner.record.supervisor, current.supervisor);
		if (scenario === "cancel") {
			await old.manager.cancel([initial.id]);
			await next.manager.cancel([initial.id]);
			assert.equal(await owner.settlement, "settled");
			assert.equal(owner.record.outcome, "interrupted");
			assert.equal(JSON.parse(readFileSync(join(root, "interrupt-count.json"), "utf8")), 1);
			assert.equal(artifacts().length, 2);
			return;
		}
		if (!before) await finish();
		await old.fire("agent_end");
		await next.fire("agent_end"); await next.fire("agent_end");
		assert.equal(old.deliveries.length, 0);
		assert.equal(next.deliveries.length, action && action !== "check" ? 0 : 1);
		if (saved) assert.deepEqual(artifacts(), saved);
	} finally { old.manager.detachForReplacement(); next.manager.detachForReplacement(); }
}
