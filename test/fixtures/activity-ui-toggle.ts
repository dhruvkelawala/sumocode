import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { FileActivityStore } from "../../src/activity/store.js";

const [rootDir, ownerSessionId, activityId, gate, ready] = process.argv.slice(2);
if (!rootDir || !ownerSessionId || !activityId || !gate || !ready) {
	throw new Error("usage: activity-ui-toggle <root> <owner> <activity> <gate> <ready>");
}

const store = new FileActivityStore({ rootDir });
store.bindSession(ownerSessionId);
writeFileSync(ready, "ready\n", { mode: 0o600 });
chmodSync(ready, 0o600);
while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
store.setExpanded(activityId, true);
store.dispose();
process.stdout.write(`${activityId}\n`);
