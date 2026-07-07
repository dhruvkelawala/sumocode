import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionTree, listSessions, readSessionInfo } from "./session-reader.js";

type PromiseConstructorWithResolvers = PromiseConstructor & {
	withResolvers<T>(): {
		promise: Promise<T>;
		resolve: (value: T | PromiseLike<T>) => void;
		reject: (reason?: unknown) => void;
	};
};

function jsonl(lines: readonly unknown[]): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("session-reader", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sumocode-session-reader-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("readSessionInfo / listSessions", () => {
		it("parses a session header, message count, and first user message", async () => {
			const file = join(dir, "2026-07-02T20-24-17-673Z_session-a.jsonl");
			writeFileSync(file, jsonl([
				{ type: "session", version: 3, id: "session-a", timestamp: "2026-07-02T20:24:17.673Z", cwd: "/repo" },
				{ type: "model_change", id: "e1", parentId: null, timestamp: "2026-07-02T20:24:21.701Z", provider: "cursor", modelId: "composer-2.5" },
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: "2026-07-02T20:24:30.322Z",
					message: { role: "user", content: [{ type: "text", text: "Hii" }], timestamp: 1783023870318 },
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: "2026-07-02T20:24:36.520Z",
					message: { role: "assistant", content: [{ type: "text", text: "Hi there" }], timestamp: 1783023876520 },
				},
			]));

			const info = await readSessionInfo(file);

			expect(info).toBeDefined();
			expect(info?.id).toBe("session-a");
			expect(info?.cwd).toBe("/repo");
			expect(info?.messageCount).toBe(2);
			expect(info?.firstMessage).toBe("Hii");
			expect(info?.name).toBeUndefined();
		});

		it("returns floor metadata for scans truncated by the byte cap", async () => {
			const file = join(dir, "2026-07-02T20-26-00-000Z_large.jsonl");
			const inWindow = jsonl([
				{ type: "session", version: 3, id: "large", timestamp: "2026-07-02T20:26:00.000Z", cwd: "/repo" },
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: "not-a-date",
					message: { role: "user", content: "visible first message" },
				},
			]);
			const cutLine = JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-07-02T20:26:01.000Z",
				message: { role: "assistant", content: "x".repeat(1000) },
			});
			const contents = `${inWindow}${cutLine}\n`;
			expect(Buffer.byteLength(inWindow, "utf8")).toBeLessThan(512);
			expect(Buffer.byteLength(contents, "utf8")).toBeGreaterThan(512);
			writeFileSync(file, contents);
			const mtime = statSync(file).mtime;

			const info = await readSessionInfo(file, { maxBytes: 512 });

			expect(info).toBeDefined();
			expect(info?.truncatedScan).toBe(true);
			expect(info?.id).toBe("large");
			expect(info?.cwd).toBe("/repo");
			expect(info?.messageCount).toBe(1);
			expect(info?.firstMessage).toBe("visible first message");
			expect(info?.modified.getTime()).toBe(mtime.getTime());
		});

		it("preserves full metadata when the file is under the byte cap", async () => {
			const file = join(dir, "2026-07-02T20-27-00-000Z_under-cap.jsonl");
			const firstActivity = new Date("2026-07-02T20:27:01.000Z").getTime();
			const secondActivity = new Date("2026-07-02T20:27:02.000Z").getTime();
			const contents = jsonl([
				{ type: "session", version: 3, id: "under-cap", timestamp: "2026-07-02T20:27:00.000Z", cwd: "/repo" },
				{ type: "session_info", id: "e1", parentId: null, timestamp: "2026-07-02T20:27:00.500Z", name: "Useful name" },
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: "2026-07-02T20:27:01.000Z",
					message: { role: "user", content: "under cap first", timestamp: firstActivity },
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: "2026-07-02T20:27:02.000Z",
					message: { role: "assistant", content: "under cap reply", timestamp: secondActivity },
				},
			]);
			writeFileSync(file, contents);

			const info = await readSessionInfo(file, { maxBytes: Buffer.byteLength(contents, "utf8") + 1 });

			expect(info).toEqual({
				path: file,
				id: "under-cap",
				cwd: "/repo",
				name: "Useful name",
				parentSessionPath: undefined,
				created: new Date("2026-07-02T20:27:00.000Z"),
				modified: new Date(secondActivity),
				messageCount: 2,
				firstMessage: "under cap first",
				truncatedScan: false,
			});
		});

		it("uses the latest session_info name, including explicit clears", async () => {
			const file = join(dir, "2026-07-02T20-25-00-000Z_session-b.jsonl");
			writeFileSync(file, jsonl([
				{ type: "session", version: 3, id: "session-b", timestamp: "2026-07-02T20:25:00.000Z", cwd: "/repo" },
				{ type: "session_info", id: "e1", parentId: null, timestamp: "2026-07-02T20:25:01.000Z", name: "First name" },
				{ type: "session_info", id: "e2", parentId: "e1", timestamp: "2026-07-02T20:25:02.000Z", name: "Second name" },
			]));

			const info = await readSessionInfo(file);
			expect(info?.name).toBe("Second name");
		});

		it("returns undefined for a file without a valid session header", async () => {
			const file = join(dir, "not-a-session.jsonl");
			writeFileSync(file, jsonl([{ type: "message", id: "e1", parentId: null, timestamp: "2026-07-02T20:25:00.000Z", message: { role: "user", content: "hi" } }]));

			expect(await readSessionInfo(file)).toBeUndefined();
		});

		it("lists sessions newest-modified first", async () => {
			writeFileSync(join(dir, "2026-07-02T20-00-00-000Z_older.jsonl"), jsonl([
				{ type: "session", version: 3, id: "older", timestamp: "2026-07-02T20:00:00.000Z", cwd: "/repo" },
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: "2026-07-02T20:00:01.000Z",
					message: { role: "user", content: "old", timestamp: 1783023601000 },
				},
			]));
			writeFileSync(join(dir, "2026-07-02T21-00-00-000Z_newer.jsonl"), jsonl([
				{ type: "session", version: 3, id: "newer", timestamp: "2026-07-02T21:00:00.000Z", cwd: "/repo" },
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: "2026-07-02T21:00:01.000Z",
					message: { role: "user", content: "new", timestamp: 1783027201000 },
				},
			]));

			const sessions = await listSessions(dir);

			expect(sessions.map((session) => session.id)).toEqual(["newer", "older"]);
		});

		it("caps listSessions reads to eight concurrent sessions", async () => {
			for (let index = 0; index < 20; index += 1) {
				writeFileSync(join(dir, `session-${index}.jsonl`), "");
			}
			let activeReads = 0;
			let maxActiveReads = 0;
			let startedReads = 0;
			let startedWaiter: { target: number; resolve: () => void } | undefined;
			const releaseReads: Array<() => void> = [];
			const waitForStarted = (target: number): Promise<void> => {
				if (startedReads >= target) return Promise.resolve();
				const { promise, resolve } = (Promise as PromiseConstructorWithResolvers).withResolvers<void>();
				startedWaiter = { target, resolve };
				return promise;
			};
			const notifyStarted = (): void => {
				if (!startedWaiter || startedReads < startedWaiter.target) return;
				startedWaiter.resolve();
				startedWaiter = undefined;
			};

			const sessionsPromise = listSessions(dir, {
				concurrency: 8,
				reader: async (filePath) => {
					activeReads += 1;
					startedReads += 1;
					maxActiveReads = Math.max(maxActiveReads, activeReads);
					const { promise, resolve } = (Promise as PromiseConstructorWithResolvers).withResolvers<void>();
					releaseReads.push(resolve);
					notifyStarted();
					await promise;
					activeReads -= 1;
					return {
						path: filePath,
						id: filePath,
						cwd: "/repo",
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "(no messages)",
						truncatedScan: false,
					};
				},
			});

			await waitForStarted(8);
			while (releaseReads.length > 0) releaseReads.shift()!();
			await waitForStarted(16);
			while (releaseReads.length > 0) releaseReads.shift()!();
			await waitForStarted(20);
			while (releaseReads.length > 0) releaseReads.shift()!();
			const sessions = await sessionsPromise;

			expect(sessions).toHaveLength(20);
			expect(maxActiveReads).toBeLessThanOrEqual(8);
		});

		it("returns an empty list for a missing directory", async () => {
			expect(await listSessions(join(dir, "does-not-exist"))).toEqual([]);
		});
	});

	describe("buildSessionTree", () => {
		it("returns undefined for a missing session file", async () => {
			expect(await buildSessionTree(join(dir, "does-not-exist.jsonl"))).toBeUndefined();
		});

		it("skips malformed JSONL lines while building valid entries", async () => {
			const file = join(dir, "2026-07-02T21-55-00-000Z_malformed.jsonl");
			writeFileSync(file, [
				JSON.stringify({ type: "session", version: 3, id: "malformed", timestamp: "2026-07-02T21:55:00.000Z", cwd: "/repo" }),
				"{not json",
				JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-07-02T21:55:01.000Z", message: { role: "user", content: "valid entry" } }),
				"",
			].join("\n"));

			const tree = await buildSessionTree(file);

			expect(tree).toHaveLength(1);
			expect(tree?.[0]?.entry.id).toBe("e1");
		});

		it("builds a branched session into a parent/child tree, oldest child first", async () => {
			const file = join(dir, "2026-07-02T22-00-00-000Z_branched.jsonl");
			writeFileSync(file, jsonl([
				{ type: "session", version: 3, id: "branched", timestamp: "2026-07-02T22:00:00.000Z", cwd: "/repo" },
				{ type: "message", id: "root", parentId: null, timestamp: "2026-07-02T22:00:01.000Z", message: { role: "user", content: "root message" } },
				{ type: "message", id: "child-b", parentId: "root", timestamp: "2026-07-02T22:00:03.000Z", message: { role: "assistant", content: "second branch" } },
				{ type: "message", id: "child-a", parentId: "root", timestamp: "2026-07-02T22:00:02.000Z", message: { role: "assistant", content: "first branch" } },
				{ type: "message", id: "grandchild", parentId: "child-a", timestamp: "2026-07-02T22:00:04.000Z", message: { role: "user", content: "reply on first branch" } },
			]));

			const tree = await buildSessionTree(file);

			expect(tree).toHaveLength(1);
			const root = tree?.[0];
			expect(root?.entry.id).toBe("root");
			expect(root?.children.map((child) => child.entry.id)).toEqual(["child-a", "child-b"]);
			const firstBranch = root?.children[0];
			expect(firstBranch?.children.map((child) => child.entry.id)).toEqual(["grandchild"]);
			expect(root?.children[1]?.children).toEqual([]);
		});

		it("treats an entry with a missing parent as an orphaned root", async () => {
			const file = join(dir, "2026-07-02T22-30-00-000Z_orphan.jsonl");
			writeFileSync(file, jsonl([
				{ type: "session", version: 3, id: "orphan", timestamp: "2026-07-02T22:30:00.000Z", cwd: "/repo" },
				{ type: "message", id: "e1", parentId: "does-not-exist", timestamp: "2026-07-02T22:30:01.000Z", message: { role: "user", content: "hi" } },
			]));

			const tree = await buildSessionTree(file);

			expect(tree).toHaveLength(1);
			expect(tree?.[0]?.entry.id).toBe("e1");
		});

		it("resolves the latest label onto its target node, honoring an explicit clear", async () => {
			const file = join(dir, "2026-07-02T22-45-00-000Z_labeled.jsonl");
			writeFileSync(file, jsonl([
				{ type: "session", version: 3, id: "labeled", timestamp: "2026-07-02T22:45:00.000Z", cwd: "/repo" },
				{ type: "message", id: "e1", parentId: null, timestamp: "2026-07-02T22:45:01.000Z", message: { role: "user", content: "hi" } },
				{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-07-02T22:45:02.000Z", message: { role: "user", content: "labeled" } },
				{ type: "label", id: "l1", parentId: "e2", timestamp: "2026-07-02T22:45:03.000Z", targetId: "e1", label: "bookmark" },
				{ type: "label", id: "l2", parentId: "l1", timestamp: "2026-07-02T22:45:04.000Z", targetId: "e2", label: "temp" },
				{ type: "label", id: "l3", parentId: "l2", timestamp: "2026-07-02T22:45:05.000Z", targetId: "e2", label: undefined },
			]));

			const tree = await buildSessionTree(file);

			const root = tree?.[0];
			expect(root?.entry.id).toBe("e1");
			expect(root?.label).toBe("bookmark");
			const messageNode = root?.children.find((child) => child.entry.id === "e2");
			expect(messageNode?.label).toBeUndefined();
		});
	});
});
