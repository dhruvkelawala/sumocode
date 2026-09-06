#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { preflightRecovery, recoveryRepo } from "./plan112-recovery-preflight.mjs";
import { HARNESS_SIGNATURE, HARNESS_SIGNATURE_ENV_KEY } from "./lib/integration-harness-constants.mjs";

// Focused counterpart to the general harness: no package build, unrelated suite,
// global preflight repair, or evidence removal. Always retain this private run.
const [root, ...payload] = process.argv.slice(2);
assert(process.env.PLAN112_RECOVERY_BACKEND === "real", "explicit real backend required");
const command = ["--", "pnpm", "exec", "vitest", "run", "test/integration/subagent-recovery.test.ts", "--fileParallelism=false"];
if (payload[0] === "--") assert.deepEqual(payload.slice(0, command.length), command, "only the recovery single-file payload is supported");
const filter = payload[0] === "--" ? payload.slice(command.length) : payload;
assert(filter.length === 0 || filter.length === 2 && filter[0] === "-t", "only an optional -t test filter is supported");
const { node, env } = await preflightRecovery(root);
const jiti = createJiti(import.meta.url, { tryNative: false, fsCache: false });
const { systemProcessTree } = await jiti.import(join(recoveryRepo, "src/background-tasks/process-tree.ts"));
const { cleanupOwnedTree } = await jiti.import(join(recoveryRepo, "test/integration/fixtures/subagent-feasibility-cleanup.ts"));
const { captureBirth } = await jiti.import(join(recoveryRepo, "test/integration/fixtures/plan112-source-controller.ts"));
const birthsPath = join(root, "births.jsonl");
// Resolve pnpm exec's checkout-local Vitest entry directly: the .bin shell
// wrapper adds NODE_PATH, which the retained source launch correctly refuses.
const child = spawn(node, [join(recoveryRepo, "node_modules/vitest/vitest.mjs"), "run", "test/integration/subagent-recovery.test.ts", "--fileParallelism=false", ...filter], {
	cwd: recoveryRepo, detached: true, stdio: "inherit",
	env: { ...env, PLAN112_RECOVERY_BACKEND: "real", PLAN112_RECOVERY_ROOT: root,
		SUMOCODE_INTEGRATION_RUN_ROOT: root, SUMOCODE_INTEGRATION_MANIFEST: join(root, "children.jsonl"),
		[HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE },
});
const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
const vitest = captureBirth(child.pid);
appendFileSync(birthsPath, `${JSON.stringify(vitest)}\n`, { mode: 0o600 });
const status = await exited;
const births = readFileSync(birthsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const failures = [];
for (const tree of [...births].reverse()) {
	if (!await cleanupOwnedTree(systemProcessTree, tree, (value) => appendFileSync(join(root, "wrapper-cleanup.jsonl"), `${JSON.stringify(value)}\n`, { mode: 0o600 }))) failures.push(tree.identity.pid);
}
const census = systemProcessTree.census();
const spawned = [child.pid];
const manifest = join(root, "children.jsonl");
if (existsSync(manifest)) for (const line of readFileSync(manifest, "utf8").trim().split("\n")) {
	const event = JSON.parse(line);
	if (event.event === "spawn") spawned.push(event.pid);
}
for (const cell of readdirSync(root).filter((name) => name.startsWith("cell-"))) {
	const path = join(root, cell, "anchor-spawn.json");
	if (existsSync(path)) spawned.push(JSON.parse(readFileSync(path, "utf8")).pid);
}
const unregistered = spawned.filter((pid) => !births.some((tree) => tree.identity.pid === pid));
const zeroOwned = census !== undefined && failures.length === 0 && unregistered.length === 0 && births.every((tree) =>
	systemProcessTree.isTreeEmpty(tree.identity, tree.verification) && !census.some((member) =>
		tree.verification.members.some((birth) => member.pid === birth.pid && member.processStartTime === birth.processStartTime)));
writeFileSync(join(root, "wrapper-zero-owned.json"), JSON.stringify({ zeroOwned, censusKnown: census !== undefined, groups: births.length, failures, unregistered, status }), { mode: 0o600 });
process.stdout.write(`[plan112 wrapper] zero-owned: ${zeroOwned}; ${births.length} birth-registered groups; evidence: ${root}\n`);
process.exitCode = zeroOwned ? status ?? 1 : 1;
