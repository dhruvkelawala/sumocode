import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const [directory, mode] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../../..");
const jiti = createJiti(import.meta.url);
const { SubagentManager } = await jiti.import(join(root, "src/subagents/manager.ts"));
const { collectManifestWithin } = await jiti.import(join(root, "src/subagents/manifest-effect.ts"));
const { buildCompletionManifest } = await jiti.import(join(root, "src/subagents/manifest.ts"));
const pidsPath = join(directory, "pids.jsonl");
writeFileSync(pidsPath, "");
writeFileSync(join(directory, "mode"), "slow");
writeFileSync(join(directory, "git"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const directory = ${JSON.stringify(directory)};
const args = process.argv.slice(2);
const command = args[2];
if (readFileSync(directory + "/mode", "utf8") === "slow") {
	process.on("SIGTERM", () => {});
	appendFileSync(directory + "/pids.jsonl", JSON.stringify({ pid: process.pid, command }) + "\\n");
	setTimeout(() => { appendFileSync(directory + "/late", "stale"); console.log("stale"); }, 20000);
} else process.stdout.write(command === "rev-parse" ? "new-head\\n" : command === "rev-list" ? "0\\n" : "");
`, { mode: 0o700 });
process.env.PATH = `${directory}:${process.env.PATH}`;
const emitters = new Map();
const signals = [];
const manager = new SubagentManager((task) => ({
	events: (emit) => { emitters.set(task.id, emit); emit({ kind: "run-started" }); },
	interrupt: () => undefined,
}), {
	captureGitContext: async () => ({ baseRef: "base" }),
	buildCompletionManifest: (options) => { signals.push(options.signal); return buildCompletionManifest(options); },
	collectCompletionManifest: (options, build, onFailure) => collectManifestWithin({
		options, build, onFailure, timeoutMs: 2000, fallback: { exit: options.outcome.kind, durationMs: 0 },
	}),
});
function pidRows() { return readFileSync(pidsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
async function waitFor(predicate) {
	const deadline = Date.now() + 1500;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Git readiness deadline");
		// WAIT-CLASS: poll-interval — poll the owned subprocess readiness receipts, not a guessed launch delay
		await new Promise((resolvePoll) => setTimeout(resolvePoll, 10));
	}
}
try {
	const old = await manager.spawn({ cwd: directory, title: "old", prompt: "old" });
	emitters.get(old.id)({ kind: "run-settled", outcome: { kind: "completed", finalText: "old" } });
	await waitFor(() => pidRows().length === 3);
	const children = pidRows();
	assert.deepEqual(children.map((row) => row.command).sort(), ["rev-list", "rev-parse", "status"]);
	if (mode === "dispose") manager.disposeAll();
	const [completion] = await manager.waitFor([old.id]);
	assert.equal(completion.status, "done");
	assert.deepEqual(completion.manifest, { exit: "completed", durationMs: 0 });
	assert.equal(signals[0].aborted, true);
	for (const { pid } of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	const frozen = manager.get(old.id);
	writeFileSync(join(directory, "mode"), "fast");
	const next = await manager.spawn({ cwd: directory, title: "new", prompt: "new" });
	emitters.get(next.id)({ kind: "run-settled", outcome: { kind: "completed", finalText: "new" } });
	const [newCompletion] = await manager.waitFor([next.id]);
	assert.equal(newCompletion.manifest.headRef, "new-head");
	assert.equal(manager.get(old.id), frozen);
	assert.equal(pidRows().length, 3);
	appendFileSync(join(directory, "evidence.jsonl"), JSON.stringify({ mode, children, completion, newCompletion, survivors: 0 }) + "\n");
	console.log(JSON.stringify({ mode, gitProcesses: children.length, survivors: 0, stalePublication: false }));
} finally { manager.disposeAll(); }
