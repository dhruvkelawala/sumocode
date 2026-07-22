import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivitySnapshot } from "./domain.js";
import {
	ACTIVITY_FEED_MAX_RECORDS,
	ACTIVITY_SETTLED_RETENTION_COUNT,
	ACTIVITY_SETTLED_RETENTION_MS,
	ActivityFeedPublisher,
	discoverActivityFeedOwners,
	parseActivityFeedDocument,
} from "./feed-publisher.js";
import { ACTIVITY_OUTPUT_MAX_BYTES, ACTIVITY_OUTPUT_MAX_LINES } from "./output-tail.js";
import { ACTIVITY_DOCUMENT_MAX_BYTES, activityPaths, atomicWritePrivateJson, hashedSessionId } from "./persistence.js";

const roots: string[] = [];

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
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ActivityFeedPublisher", () => {
	it("uses a hashed private path and atomically publishes one owner feed", () => {
		const stateRoot = root();
		const owner = "raw/session/id with spaces";
		const publisher = new ActivityFeedPublisher(owner, { rootDir: stateRoot, now: () => 2_000 });
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
		const publisher = new ActivityFeedPublisher("session-a", { rootDir: stateRoot });
		expect(() => publisher.publish([activity("term-a")])).toThrow("publication blocked");
		expect(JSON.parse(readFileSync(paths.feedFile, "utf8"))).toMatchObject({ schemaVersion: 999, retained: "future-data" });
	});

	it("suppresses semantic no-op writes and discovers owners from feed contents", () => {
		const stateRoot = root();
		const publisher = new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		expect(publisher.publish([activity("term-1")])).toBe(true);
		expect(publisher.publish([activity("term-1")])).toBe(false);
		expect(discoverActivityFeedOwners({ rootDir: stateRoot })).toEqual(["session-a"]);
	});

	it("bounds and sanitizes output, invocation secrets, ANSI, and controls", () => {
		const stateRoot = root();
		const publisher = new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => 2_000 });
		const noisy = `${Array.from({ length: 80 }, (_, index) => `\u001b[31m${index}:${"🧘".repeat(400)}\u001b[0m\t`).join("\n")}\nAuthorization: Bearer output-secret\nAuthorization: Basic YmFzaWMtc2VjcmV0\nAuthorization: AWS4-HMAC-SHA256 Credential=aws-secret\nProxy-Authorization: Digest proxy-secret\nCookie: session=cookie-secret\nSet-Cookie: auth=set-cookie-secret\nX-Api-Key: header-key-secret\nBearer bare-secret\nDATABASE_URL=postgres://user:db-password@host/db\nAWS_ACCESS_KEY_ID=AKIA1234567890123456\ngithub_pat_abcdefghijklmnopqrstuvwxyz\nxoxb-1234567890-secret\nnpm_abcdefghijklmnop\nsk_live_abcdefghijklmnop\nrk_live_abcdefghijklmnop\nAIza${"A".repeat(20)}${"1".repeat(15)}\naBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCD\n+ curl -u alice:hunter2 https://host\npassword prose-secret\npassword is prose-is-secret\nclient secret is client-secret-value\ndeploy --token opaque-secret --password 'quoted-secret' --api-key=key-secret\nopenai_api_key=prefixed-secret\ngithub_token=github-secret\ndb_password=db-secret\n\"service_client_secret\":\"json-secret\"\nAPI_KEY=env-secret\n${"A".repeat(64)}\n${"B".repeat(64)}\nsk-abcdefghijklmnop`;
		publisher.publish([activity("term-1", {
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
		expect(stored!.body).toEqual(expect.objectContaining({ kind: "terminal" }));
		expect(stored!.body).not.toHaveProperty("command");
		expect(JSON.stringify(stored)).not.toMatch(/output-secret|YmFzaWMtc2VjcmV0|aws-secret|proxy-secret|cookie-secret|set-cookie-secret|header-key-secret|bare-secret|db-password|AKIA1234567890123456|github_pat_abcdefghijklmnopqrstuvwxyz|xoxb-1234567890-secret|npm_abcdefghijklmnop|sk_live_abcdefghijklmnop|rk_live_abcdefghijklmnop|AIzaA{20}1{15}|aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCD|alice:hunter2|prose-secret|prose-is-secret|client-secret-value|opaque-secret|quoted-secret|key-secret|prefixed-secret|github-secret|db-secret|json-secret|env-secret|abcdefghijklmnop|result-secret/);
		expect(JSON.stringify(stored)).toContain("[REDACTED]");
		expect(JSON.stringify(stored)).toContain("[REDACTED KEY MATERIAL]");
	});

	it("fits every running record under the reader's document cap", () => {
		const stateRoot = root();
		const owner = "session-a";
		const publisher = new ActivityFeedPublisher(owner, { rootDir: stateRoot, now: () => 2_000 });
		const running = Array.from({ length: 300 }, (_, index) => activity(`running-${index}`, {
			outputTail: "x".repeat(ACTIVITY_OUTPUT_MAX_BYTES),
			body: { kind: "terminal", text: "x".repeat(ACTIVITY_OUTPUT_MAX_BYTES) },
		}));
		publisher.publish(running);

		const paths = activityPaths(owner, stateRoot);
		expect(statSync(paths.feedFile).size).toBeLessThanOrEqual(ACTIVITY_DOCUMENT_MAX_BYTES);
		expect(new ActivityFeedPublisher(owner, { rootDir: stateRoot }).getSnapshot()).toHaveLength(running.length);
	});

	it("rejects persisted feeds above the bounded record count", () => {
		const activities = Array.from({ length: ACTIVITY_FEED_MAX_RECORDS + 1 }, (_, index) => ({
			...activity(`term-${index}`),
			ownerSessionId: "session-a",
		}));
		expect(() => new ActivityFeedPublisher("session-a", { rootDir: root(), now: () => 1 }).publish(activities))
			.toThrow(`Activity feed exceeds ${ACTIVITY_FEED_MAX_RECORDS} records`);
		expect(parseActivityFeedDocument({
			schemaVersion: 1,
			ownerSessionId: "session-a",
			revision: 1,
			updatedAt: 1,
			activities,
		}, "session-a")).toBeUndefined();
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
		const publisher = new ActivityFeedPublisher("session-a", { rootDir: stateRoot, now: () => now });
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
