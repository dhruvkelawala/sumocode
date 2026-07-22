import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { TerminalTaskStore, StaleTerminalTaskRevisionError } from "../../src/background-tasks/task-store.js";

const [rootDir, id, gate, ready] = process.argv.slice(2);
if (!rootDir || !id || !gate || !ready) throw new Error("usage: terminal-store-racer <root> <id> <gate> <ready>");

const store = new TerminalTaskStore({ rootDir });
store.loadAll();
writeFileSync(ready, "ready\n", { mode: 0o600 });
chmodSync(ready, 0o600);
while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

try {
	store.transition(id, 1, (current) => ({ ...current, title: `writer-${process.pid}`, updatedAt: 2_000 }));
	process.stdout.write("success\n");
} catch (error) {
	if (!(error instanceof StaleTerminalTaskRevisionError)) throw error;
	process.stdout.write("stale\n");
}
