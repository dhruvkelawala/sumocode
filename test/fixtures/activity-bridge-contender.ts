import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { ActivityFeedPublisher, type ActivityFeedWriterIdentity, type ActivityFeedWriterState } from "../../src/activity/feed-publisher.js";
import { ActivityManagerBridge } from "../../src/activity/manager-bridge.js";
import { captureProcessBirthTime } from "../../src/background-tasks/process-tree.js";
import { TerminalTaskManager } from "../../src/background-tasks/task-manager.js";
import { TerminalTaskStore } from "../../src/background-tasks/task-store.js";

const [stateRoot, terminalRoot, ownerSessionId, ready, deathGate, takeoverGate] = process.argv.slice(2);
if (!stateRoot || !terminalRoot || !ownerSessionId || !ready || !deathGate || !takeoverGate) {
	throw new Error("usage: activity-bridge-contender <state-root> <terminal-root> <owner> <ready> <death-gate> <takeover-gate>");
}

function inspectWriter(writer: ActivityFeedWriterIdentity): ActivityFeedWriterState {
	if (writer.token === "incumbent") return existsSync(deathGate) ? "dead" : "alive";
	try {
		process.kill(writer.pid, 0);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && String(error.code) === "ESRCH") return "dead";
		return "unknown";
	}
	const actual = captureProcessBirthTime(writer.pid);
	return actual === writer.processStartTime ? "alive" : actual ? "dead" : "unknown";
}

const processStartTime = captureProcessBirthTime(process.pid);
if (!processStartTime) throw new Error("contender process identity is unverifiable");
const terminalManager = new TerminalTaskManager({
	store: new TerminalTaskStore({ rootDir: terminalRoot }),
	pollIntervalMs: 25,
});
const subagentManager = {
	list: () => [],
	addChangeListener: () => () => undefined,
};
const claims = new Map<string, string>();
const bridge = new ActivityManagerBridge(terminalManager, subagentManager, {
	rootDir: stateRoot,
	writerIdentity: { token: "contender", pid: process.pid, processStartTime },
	inspectWriter,
	sessionOwnership: {
		ownedSessionIds: () => [ownerSessionId],
		claim: (owner, token) => {
			const current = claims.get(owner);
			if (current && current !== token) return false;
			claims.set(owner, token);
			return true;
		},
		release: (owner, token) => { if (claims.get(owner) === token) claims.delete(owner); },
	},
});

bridge.bindSession(ownerSessionId);
writeFileSync(ready, "ready\n", { mode: 0o600 });
chmodSync(ready, 0o600);
while (!existsSync(takeoverGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
bridge.bindSession(ownerSessionId);

const deadline = Date.now() + 10_000;
let result: { id: string; status: string; processIdentityVerified: boolean } | undefined;
while (Date.now() < deadline) {
	const task = terminalManager.getSnapshots().find((candidate) => candidate.ownerSessionId === ownerSessionId);
	const activity = new ActivityFeedPublisher(ownerSessionId, { rootDir: stateRoot }).getSnapshot()
		.find((candidate) => candidate.id === task?.id);
	if (task && activity) {
		result = {
			id: task.id,
			status: activity.status,
			processIdentityVerified: (task.processTreeVerification?.members.length ?? 0) > 0,
		};
		if (result.processIdentityVerified) break;
	}
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

bridge.dispose();
terminalManager.detach();
if (!result) throw new Error("contender did not adopt the late terminal");
process.stdout.write(`${JSON.stringify(result)}\n`);
