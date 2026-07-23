import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivitySnapshot } from "./domain.js";
import {
	ACTIVITY_SETTLED_RETENTION_COUNT,
	ACTIVITY_SETTLED_RETENTION_MS,
	ActivityFeedPublisher,
	parseActivityFeedDocument,
	type ActivityFeedPublisherOptions,
} from "./feed-publisher.js";
import { ACTIVITY_OUTPUT_MAX_BYTES, ACTIVITY_OUTPUT_MAX_LINES } from "./output-tail.js";
import { ACTIVITY_DOCUMENT_MAX_BYTES, ACTIVITY_FEED_MAX_BYTES, activityPaths, atomicWritePrivateJson, hashedSessionId } from "./persistence.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-activity-feed-"));
	roots.push(path);
	return path;
}

function activity(id: string, overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
	return {
		id,
		kind: "terminal",
		title: id,
		status: "running",
		createdAt: 1_000,
		updatedAt: 1_000,
		...overrides,
	};
}

afterEach(() => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGTERM");
	}
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function spawnFeedWriter(rootDir: string, ownerSessionId: string, id: string, holdMs = 0): Promise<{
	readonly child: ChildProcessWithoutNullStreams;
	readonly result: { readonly published: boolean; readonly writerDeathProven: boolean; readonly error?: string };
}> {
	const jitiPath = require.resolve("jiti");
	const publisherPath = join(process.cwd(), "src", "activity", "feed-publisher.ts");
	const processTreePath = join(process.cwd(), "src", "background-tasks", "process-tree.ts");
	const source = `
const { createJiti } = require(${JSON.stringify(jitiPath)});
const jiti = createJiti(${JSON.stringify(join(process.cwd(), "feed-writer-test.cjs"))}, { moduleCache: false, tryNative: false });
(async () => {
  const { ActivityFeedPublisher } = await jiti.import(${JSON.stringify(publisherPath)});
  const { captureProcessBirthTime } = await jiti.import(${JSON.stringify(processTreePath)});
  const processStartTime = captureProcessBirthTime(process.pid);
  if (!processStartTime) throw new Error("unverifiable child process");
  const inspectWriter = (writer) => {
    try { process.kill(writer.pid, 0); } catch (error) { if (error && error.code === "ESRCH") return "dead"; return "unknown"; }
    const actual = captureProcessBirthTime(writer.pid);
    return actual === writer.processStartTime ? "alive" : actual ? "dead" : "unknown";
  };
  const publisher = new ActivityFeedPublisher(${JSON.stringify(ownerSessionId)}, {
    rootDir: ${JSON.stringify(rootDir)},
    writerIdentity: { token: ${JSON.stringify(id)}, pid: process.pid, processStartTime },
    inspectWriter,
  });
  let published = false;
  let error;
  try {
    published = publisher.publish([{ id: ${JSON.stringify(id)}, kind: "subagent", title: ${JSON.stringify(id)}, status: "running", createdAt: Date.now() }]);
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  process.stdout.write(JSON.stringify({ published, writerDeathProven: publisher.canReconcileAbandonedActivities, error }) + "\\n");
  if (${holdMs} > 0) setTimeout(() => process.exit(0), ${holdMs});
})().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });
`;
	const child = spawn(process.execPath, ["-e", source], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
	children.push(child);
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for feed writer ${id}: ${stderr}`)), 10_000);
		child.stderr.on("data", (data) => { stderr += data.toString(); });
		child.stdout.on("data", (data) => {
			stdout += data.toString();
			const newline = stdout.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timer);
			resolve({ child, result: JSON.parse(stdout.slice(0, newline)) });
		});
		child.once("exit", (code) => {
			if (stdout.includes("\n")) return;
			clearTimeout(timer);
			reject(new Error(`Feed writer ${id} exited ${String(code)}: ${stderr}`));
		});
	});
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function fixturePublisher(ownerSessionId: string, options: ActivityFeedPublisherOptions = {}): ActivityFeedPublisher {
	return new ActivityFeedPublisher(ownerSessionId, { ...options, allowUnleasedWritesForTests: true });
}

describe("ActivityFeedPublisher", () => {
	it("uses a hashed private path and atomically publishes one owner feed", () => {
		const stateRoot = root();
		const owner = "raw/session/id with spaces";
		const publisher = fixturePublisher(owner, { rootDir: stateRoot, now: () => 2_000 });
		expect(publisher.publish([activity("term-1")])).toBe(true);

		const paths = activityPaths(owner, stateRoot);
		expect(paths.directory).toContain(hashedSessionId(owner));
		expect(paths.directory).not.toContain(owner);
		const parsed = parseActivityFeedDocument(JSON.parse(readFileSync(paths.feedFile, "utf8")), owner);
		expect(parsed?.activities).toMatchObject([{ id: "term-1", ownerSessionId: owner }]);
		if (process.platform !== "win32") {
			expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
			expect(statSync(paths.feedFile).mode & 0o777).toBe(0o600);
		}
	});

	it("keeps unidentified publishers read-only and never lets fixture writes bypass a lease", () => {
		const stateRoot = root();
		const reader = new ActivityFeedPublisher("session-read-only", { rootDir: stateRoot });
		expect(reader.hasWriterOwnership).toBe(false);
		expect(() => reader.publish([activity("denied")])).toThrow("owned by another live session writer");

		const leased = new ActivityFeedPublisher("session-leased", {
			rootDir: stateRoot,
			writerIdentity: { token: "leased", pid: 111, processStartTime: "start" },
			inspectWriter: () => "alive",
		});
		leased.publish([activity("leased")]);
		const fixture = fixturePublisher("session-leased", { rootDir: stateRoot });
		expect(fixture.hasWriterOwnership).toBe(false);
		expect(() => fixture.publish([activity("bypass")])).toThrow("owned by another live session writer");
		expect(fixture.getSnapshot().map((entry) => entry.id)).toEqual(["leased"]);
	});

	it("rejects planted root/session symlinks before changing target permissions", () => {
		if (process.platform === "win32") return;
		const stateRoot = root();
		const outsideRoot = root();
		const outsideV1 = join(outsideRoot, "outside-v1");
		mkdirSync(outsideV1, { mode: 0o755 });
		chmodSync(outsideV1, 0o755);
		mkdirSync(join(stateRoot, "sumocode", "activity"), { recursive: true });
		symlinkSync(outsideV1, join(stateRoot, "sumocode", "activity", "v1"), "dir");

		expect(() => activityPaths("session-a", stateRoot)).toThrow(/not a directory/);
		expect(statSync(outsideV1).mode & 0o777).toBe(0o755);

		const cleanRoot = root();
		activityPaths("seed", cleanRoot);
		const outsideSession = join(outsideRoot, "outside-session");
		mkdirSync(outsideSession, { mode: 0o755 });
		chmodSync(outsideSession, 0o755);
		const sessionPath = join(cleanRoot, "sumocode", "activity", "v1", hashedSessionId("session-b"));
		symlinkSync(outsideSession, sessionPath, "dir");

		expect(() => activityPaths("session-b", cleanRoot)).toThrow(/not a directory/);
		expect(statSync(outsideSession).mode & 0o777).toBe(0o755);
	});

	it("refuses to overwrite an unknown-schema persisted feed", () => {
		const stateRoot = root();
		const paths = activityPaths("session-a", stateRoot);
		atomicWritePrivateJson(paths.feedFile, { schemaVersion: 999, ownerSessionId: "session-a", retained: "future-data" });
		const publisher = fixturePublisher("session-a", { rootDir: stateRoot });
		expect(publisher.canPublish).toBe(false);
		expect(() => publisher.publish([activity("term-a")])).toThrow("publication blocked");
		expect(JSON.parse(readFileSync(paths.feedFile, "utf8"))).toMatchObject({ schemaVersion: 999, retained: "future-data" });
	});

	it("suppresses semantic no-op writes without scanning unrelated session feeds", () => {
		const stateRoot = root();
		const publisher = fixturePublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		expect(publisher.publish([activity("term-1")])).toBe(true);
		expect(publisher.publish([activity("term-1")])).toBe(false);
	});

	it("allows different Pi processes to publish only their separately owned sessions", async () => {
		const stateRoot = root();
		const first = await spawnFeedWriter(stateRoot, "session-a", "writer-a", 10_000);
		const second = await spawnFeedWriter(stateRoot, "session-b", "writer-b");
		expect(first.result).toMatchObject({ published: true, writerDeathProven: false });
		expect(second.result).toMatchObject({ published: true, writerDeathProven: false });
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()).toMatchObject([{ id: "writer-a", status: "running" }]);
		expect(fixturePublisher("session-b", { rootDir: stateRoot }).getSnapshot()).toMatchObject([{ id: "writer-b", status: "running" }]);
		first.child.kill("SIGTERM");
		await waitForExit(first.child);
	});

	it("serializes a same-session process race and permits takeover only after writer death", async () => {
		const stateRoot = root();
		const first = await spawnFeedWriter(stateRoot, "session-race", "writer-first", 10_000);
		const contender = await spawnFeedWriter(stateRoot, "session-race", "writer-contender");
		expect(first.result.published).toBe(true);
		expect(contender.result).toMatchObject({ published: false, writerDeathProven: false });
		expect(contender.result.error).toMatch(/another live session writer/);
		expect(fixturePublisher("session-race", { rootDir: stateRoot }).getSnapshot()).toMatchObject([{ id: "writer-first", status: "running" }]);

		first.child.kill("SIGTERM");
		await waitForExit(first.child);
		const takeover = await spawnFeedWriter(stateRoot, "session-race", "writer-takeover");
		expect(takeover.result).toMatchObject({ published: true, writerDeathProven: true });
		expect(fixturePublisher("session-race", { rootDir: stateRoot }).getSnapshot()).toMatchObject([{ id: "writer-takeover", status: "running" }]);
	});

	it("loads an incumbent's final feed update after a death-proven writer takeover", () => {
		const stateRoot = root();
		const first = fixturePublisher("session-final-update", {
			rootDir: stateRoot,
			writerIdentity: { token: "first", pid: 111, processStartTime: "first-start" },
			inspectWriter: () => "alive",
		});
		first.publish([activity("before")]);
		let wroteFinal = false;
		const takeover = fixturePublisher("session-final-update", {
			rootDir: stateRoot,
			writerIdentity: { token: "takeover", pid: 222, processStartTime: "takeover-start" },
			inspectWriter: () => {
				if (!wroteFinal) {
					wroteFinal = true;
					first.publish([activity("before"), activity("final")]);
				}
				return "dead";
			},
		});
		expect(takeover.hasWriterOwnership).toBe(true);
		expect(takeover.getSnapshot().map((entry) => entry.id)).toEqual(["before", "final"]);
		takeover.publish(takeover.getSnapshot());
		expect(fixturePublisher("session-final-update", { rootDir: stateRoot }).getSnapshot().map((entry) => entry.id)).toEqual(["before", "final"]);
	});

	it("restores its live canonical lease after a contender crashes mid-takeover", () => {
		const stateRoot = root();
		const identity = { token: "live-owner", pid: 111, processStartTime: "live-start" };
		const publisher = new ActivityFeedPublisher("session-live-recovery", {
			rootDir: stateRoot,
			writerIdentity: identity,
			inspectWriter: () => "alive",
		});
		publisher.publish([activity("before")]);
		const paths = activityPaths("session-live-recovery", stateRoot);
		renameSync(paths.writerFile, `${paths.writerFile}.takeover-crashed-contender`);

		expect(publisher.publish([activity("after")])).toBe(true);
		expect(new ActivityFeedPublisher("session-live-recovery", { rootDir: stateRoot }).getSnapshot().map((entry) => entry.id)).toEqual(["after"]);
		expect(readFileSync(paths.writerFile, "utf8")).toContain(identity.token);
	});

	it("preserves writer-death proof when recovering an abandoned takeover path", () => {
		const stateRoot = root();
		const first = fixturePublisher("session-abandoned", {
			rootDir: stateRoot,
			writerIdentity: { token: "first", pid: 111, processStartTime: "first-start" },
			inspectWriter: () => "alive",
		});
		first.publish([activity("still-running")]);
		const paths = activityPaths("session-abandoned", stateRoot);
		renameSync(paths.writerFile, `${paths.writerFile}.takeover-crashed`);

		const recovered = fixturePublisher("session-abandoned", {
			rootDir: stateRoot,
			writerIdentity: { token: "recovered", pid: 222, processStartTime: "recovered-start" },
			inspectWriter: () => "dead",
		});
		expect(recovered.hasWriterOwnership).toBe(true);
		expect(recovered.canReconcileAbandonedActivities).toBe(true);
	});

	it("bounds and sanitizes output, invocation secrets, ANSI, and controls", () => {
		const stateRoot = root();
		const publisher = fixturePublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		const noisy = `${Array.from({ length: 80 }, (_, index) => `\u001b[31m${index}:${"🧘".repeat(400)}\u001b[0m\t`).join("\n")}\nAuthorization: Bearer output-secret\nAuthorization: Basic YmFzaWMtc2VjcmV0\nAuthorization: AWS4-HMAC-SHA256 Credential=aws-secret\nProxy-Authorization: Digest proxy-secret\nCookie: session=cookie-secret\nSet-Cookie: auth=set-cookie-secret\nX-Api-Key: header-key-secret\nBearer bare-secret\nDATABASE_URL=postgres://user:db-password@host/db\nAWS_ACCESS_KEY_ID=AKIA1234567890123456\ngithub_pat_abcdefghijklmnopqrstuvwxyz\nxoxb-1234567890-secret\nnpm_abcdefghijklmnop\nsk_live_abcdefghijklmnop\nrk_live_abcdefghijklmnop\nAIza${"A".repeat(20)}${"1".repeat(15)}\naBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCD\n+ curl -u alice:hunter2 https://host\npassword prose-secret\npassword is prose-is-secret\nclient secret is client-secret-value\ndeploy --token opaque-secret --password 'quoted-secret' --api-key=key-secret\nopenai_api_key=prefixed-secret\ngithub_token=github-secret\ndb_password=db-secret\n\"service_client_secret\":\"json-secret\"\nAPI_KEY=env-secret\n${"A".repeat(64)}\n${"B".repeat(64)}\nsk-abcdefghijklmnop`;
		publisher.publish([activity("term-1", {
			subject: "/Users/private/opaque-cwd-canary",
			currentStep: "Authorization: Bearer current-step-secret",
			invocation: { command: "run", authorization: "Bearer secret", nested: { apiKey: "also-secret" } },
			outputTail: noisy,
			body: { kind: "terminal", command: "\u001b[32mrun\u001b[0m", text: noisy },
			result: { summary: "password=result-secret" },
		})]);
		const [stored] = publisher.getSnapshot();
		expect(stored).toBeDefined();
		expect(Buffer.byteLength(stored!.outputTail ?? "", "utf8")).toBeLessThanOrEqual(ACTIVITY_OUTPUT_MAX_BYTES);
		expect((stored!.outputTail ?? "").split("\n").length).toBeLessThanOrEqual(ACTIVITY_OUTPUT_MAX_LINES);
		expect(stored!.outputTail).not.toContain("\u001b");
		expect(stored!.invocation).toBeUndefined();
		expect(stored!.subject).toBeUndefined();
		expect(JSON.stringify(stored)).not.toContain("opaque-cwd-canary");
		expect(JSON.stringify(stored)).not.toContain("current-step-secret");
		expect(stored!.body).toEqual(expect.objectContaining({ kind: "terminal" }));
		expect(stored!.body).not.toHaveProperty("command");
		expect(JSON.stringify(stored)).not.toMatch(/output-secret|YmFzaWMtc2VjcmV0|aws-secret|proxy-secret|cookie-secret|set-cookie-secret|header-key-secret|bare-secret|db-password|AKIA1234567890123456|github_pat_abcdefghijklmnopqrstuvwxyz|xoxb-1234567890-secret|npm_abcdefghijklmnop|sk_live_abcdefghijklmnop|rk_live_abcdefghijklmnop|AIzaA{20}1{15}|aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCD|alice:hunter2|prose-secret|prose-is-secret|client-secret-value|opaque-secret|quoted-secret|key-secret|prefixed-secret|github-secret|db-secret|json-secret|env-secret|abcdefghijklmnop|result-secret/);
		expect(JSON.stringify(stored)).toContain("[REDACTED]");
		expect(JSON.stringify(stored)).toContain("[REDACTED KEY MATERIAL]");
	});

	it("retains every running identity/status when metadata alone exceeds the optional 4 MiB payload budget", () => {
		const stateRoot = root();
		const owner = "session-many-running";
		const publisher = fixturePublisher(owner, { rootDir: stateRoot, now: () => 2_000 });
		const running = Array.from({ length: 20_000 }, (_, index) => activity(`running-${index}`, {
			title: `terminal-${index}-${"t".repeat(480)}`,
			subject: `optional-${"s".repeat(480)}`,
		}));
		publisher.publish(running);

		const paths = activityPaths(owner, stateRoot);
		const size = statSync(paths.feedFile).size;
		expect(size).toBeGreaterThan(ACTIVITY_DOCUMENT_MAX_BYTES);
		expect(size).toBeLessThanOrEqual(ACTIVITY_FEED_MAX_BYTES);
		const reloaded = fixturePublisher(owner, { rootDir: stateRoot }).getSnapshot();
		expect(reloaded).toHaveLength(running.length);
		expect(reloaded.every((entry) => entry.id.startsWith("running-") && entry.status === "running")).toBe(true);
		expect(reloaded.every((entry) => entry.subject === undefined && entry.outputTail === undefined)).toBe(true);
	}, 20_000);

	it("redacts known secret patterns while treating opaque output as private user-visible session data", () => {
		const stateRoot = root();
		const publisher = fixturePublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		publisher.publish([activity("term-output-policy", {
			invocation: { command: "never persist this command", env: { TOKEN: "never-persist-env" } },
			outputTail: "API_TOKEN=known-pattern-canary\nopaque-user-data::mauve-river-731",
			body: { kind: "terminal", command: "never persist this command", text: "API_TOKEN=known-pattern-canary\nopaque-user-data::mauve-river-731" },
		})]);
		const serialized = JSON.stringify(publisher.getSnapshot()[0]);
		expect(serialized).not.toContain("known-pattern-canary");
		expect(serialized).not.toContain("never persist this command");
		expect(serialized).not.toContain("never-persist-env");
		expect(serialized).not.toContain('"invocation"');
		expect(serialized).not.toContain('"command"');
		// No heuristic can classify every opaque value. The private durable tail
		// is session-visible output, not a secret-proof vault.
		expect(serialized).toContain("opaque-user-data::mauve-river-731");
	});

	it("fits every running record under the reader's document cap", () => {
		const stateRoot = root();
		const owner = "session-a";
		const publisher = fixturePublisher(owner, { rootDir: stateRoot, now: () => 2_000 });
		const running = Array.from({ length: 300 }, (_, index) => activity(`running-${index}`, {
			outputTail: "x".repeat(ACTIVITY_OUTPUT_MAX_BYTES),
			body: { kind: "terminal", text: "x".repeat(ACTIVITY_OUTPUT_MAX_BYTES) },
		}));
		publisher.publish(running);

		const paths = activityPaths(owner, stateRoot);
		expect(statSync(paths.feedFile).size).toBeLessThanOrEqual(ACTIVITY_DOCUMENT_MAX_BYTES);
		expect(fixturePublisher(owner, { rootDir: stateRoot }).getSnapshot()).toHaveLength(running.length);
	});

	it("bounds deeply nested persisted invocation data during feed parsing", () => {
		let invocation: Record<string, unknown> = { leaf: "value" };
		for (let depth = 0; depth < 20_000; depth += 1) invocation = { next: invocation };
		const parsed = parseActivityFeedDocument({
			schemaVersion: 1,
			ownerSessionId: "session-a",
			revision: 1,
			updatedAt: 1,
			activities: [{
				id: "nested",
				kind: "terminal",
				title: "nested",
				status: "running",
				ownerSessionId: "session-a",
				invocation,
			}],
		}, "session-a");

		expect(parsed).toBeDefined();
		expect(parsed?.activities[0]?.invocation).toBeUndefined();
	});

	it("retains every running activity plus only the newest 64 settled within seven days", () => {
		const stateRoot = root();
		const now = 10 * ACTIVITY_SETTLED_RETENTION_MS;
		const publisher = fixturePublisher("session-a", { rootDir: stateRoot, now: () => now });
		const running = [activity("running-a"), activity("running-b")];
		const settled = Array.from({ length: ACTIVITY_SETTLED_RETENTION_COUNT + 10 }, (_, index) => activity(`settled-${index}`, {
			status: "succeeded",
			createdAt: now - 1_000 - index,
			updatedAt: now - 1_000 - index,
			settledAt: now - 1_000 - index,
		}));
		const stale = activity("stale", {
			status: "failed",
			createdAt: now - ACTIVITY_SETTLED_RETENTION_MS - 1,
			updatedAt: now - ACTIVITY_SETTLED_RETENTION_MS - 1,
			settledAt: now - ACTIVITY_SETTLED_RETENTION_MS - 1,
		});
		publisher.publish([...running, ...settled, stale]);
		const ids = publisher.getSnapshot().map((candidate) => candidate.id);
		expect(ids).toContain("running-a");
		expect(ids).toContain("running-b");
		expect(ids).not.toContain("stale");
		expect(ids.filter((id) => id.startsWith("settled-"))).toHaveLength(ACTIVITY_SETTLED_RETENTION_COUNT);
		expect(ids).toContain("settled-0");
		expect(ids).not.toContain(`settled-${ACTIVITY_SETTLED_RETENTION_COUNT + 9}`);
	});
});
