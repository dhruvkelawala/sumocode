import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_ALL_SESSIONS, buildSessionTree, listAllSessions, listAllSessionsForSession, listProjectSessions, listSessions, readSessionInfo } from "./session-reader.js";

type PromiseConstructorWithResolvers = PromiseConstructor & {
	withResolvers<T>(): {
		promise: Promise<T>;
		resolve: (value: T | PromiseLike<T>) => void;
		reject: (cause?: unknown) => void;
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
				// SAFETY: withResolvers is the standard ES2024 Promise API; the
				// intersection narrows the lib constructor to that overload.
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
					// SAFETY: standard ES2024 withResolvers overload, as above.
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

	describe("listAllSessions", () => {
		/** Pi's file name is the ISO creation timestamp with `:`/`.` dashed. */
		const fileNameFor = (offsetMinutes: number, id: string): string =>
			`${new Date(Date.UTC(2026, 6, 2, 20, offsetMinutes)).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;

		const writeSession = (file: string, id: string, timestamp: string, cwd = "/repo"): string => {
			writeFileSync(file, jsonl([
				{ type: "session", version: 3, id, timestamp, cwd },
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp,
					message: { role: "user", content: `first ${id}`, timestamp: new Date(timestamp).getTime() },
				},
			]));
			return file;
		};

		const isoAt = (offsetMinutes: number): string => new Date(Date.UTC(2026, 6, 2, 20, offsetMinutes)).toISOString();

		it("lists sessions from every project directory under the sessions root", async () => {
			const sessionsRoot = join(dir, "sessions");
			const projectA = join(sessionsRoot, "--repo-a--");
			const projectB = join(sessionsRoot, "--repo-b--");
			mkdirSync(join(projectA, "nested"), { recursive: true });
			mkdirSync(projectB, { recursive: true });
			writeSession(join(projectA, fileNameFor(0, "a")), "a", isoAt(0), "/repo-a");
			writeSession(join(projectB, fileNameFor(10, "b")), "b", isoAt(10), "/repo-b");
			// Only one level below the root is walked, matching Pi's
			// `<sessions>/<encoded-cwd>/<file>.jsonl` layout.
			writeSession(join(projectA, "nested", fileNameFor(20, "nested")), "nested", isoAt(20), "/repo-a");
			writeFileSync(join(projectA, "notes.txt"), "not a session");

			const sessions = await listAllSessions(sessionsRoot);

			expect(sessions.map((session) => session.id)).toEqual(["b", "a"]);
			expect(sessions.map((session) => session.cwd)).toEqual(["/repo-b", "/repo-a"]);
		});

		it("reads at most maxSessions files, newest-active first, on a large synthetic store", async () => {
			const sessionsRoot = join(dir, "sessions");
			for (let project = 0; project < 6; project += 1) {
				const projectDir = join(sessionsRoot, `--repo-${project}--`);
				mkdirSync(projectDir, { recursive: true });
				for (let index = 0; index < 10; index += 1) {
					const offset = project * 10 + index;
					const id = `p${project}-${index}`;
					writeSession(join(projectDir, fileNameFor(offset, id)), id, isoAt(offset), `/repo-${project}`);
				}
			}
			const read: string[] = [];

			const sessions = await listAllSessions(sessionsRoot, {
				maxSessions: 5,
				reader: async (filePath) => {
					read.push(filePath);
					return readSessionInfo(filePath);
				},
			});

			expect(read).toHaveLength(5);
			expect(sessions.map((session) => session.id)).toEqual(["p5-9", "p5-8", "p5-7", "p5-6", "p5-5"]);
		});

		it("surfaces recently-active sessions ahead of newer-created quiet ones", async () => {
			const sessionsRoot = join(dir, "sessions");
			const quietDir = join(sessionsRoot, "--quiet--");
			const activeDir = join(sessionsRoot, "--active--");
			mkdirSync(quietDir, { recursive: true });
			mkdirSync(activeDir, { recursive: true });
			const now = Date.now();
			// Active project: older creation names, appended to most recently --
			// writing to an existing session file moves the file's mtime and leaves
			// its directory's untouched.
			const activeFiles = [0, 1, 2].map((index) => writeSession(join(activeDir, fileNameFor(index, `active-${index}`)), `active-${index}`, isoAt(index), "/active"));
			// Quiet project: files with the newest creation names, written last so the
			// quiet directory also carries the newest directory mtime -- directory
			// metadata points the opposite way from session activity here.
			const quietFiles = [0, 1, 2].map((index) => writeSession(join(quietDir, fileNameFor(50 + index, `quiet-${index}`)), `quiet-${index}`, isoAt(50 + index), "/quiet"));
			for (const file of activeFiles) utimesSync(file, new Date(now - 5_000), new Date(now - 5_000));
			for (const file of quietFiles) utimesSync(file, new Date(now - 60_000), new Date(now - 60_000));

			const sessions = await listAllSessions(sessionsRoot, { maxSessions: 2 });

			expect(sessions.map((session) => session.id)).toEqual(["active-2", "active-1"]);
		});

		it("ranks candidates globally, so one busy project cannot fill the window", async () => {
			const sessionsRoot = join(dir, "sessions");
			const busyDir = join(sessionsRoot, "--busy--");
			const otherDir = join(sessionsRoot, "--other--");
			mkdirSync(busyDir, { recursive: true });
			mkdirSync(otherDir, { recursive: true });
			const now = Date.now();
			// Other project: older creation names, but active since the busy ones were.
			const otherFiles = [0, 1].map((index) => writeSession(join(otherDir, fileNameFor(index, `other-${index}`)), `other-${index}`, isoAt(index), "/other"));
			// Busy project: more sessions than the entire window, newest names.
			// Written last, so the busy directory also carries the newest directory
			// mtime -- directory metadata points the opposite way from activity here.
			const busyFiles: string[] = [];
			for (let index = 0; index < DEFAULT_MAX_ALL_SESSIONS + 3; index += 1) {
				busyFiles.push(writeSession(join(busyDir, fileNameFor(200 + index, `busy-${index}`)), `busy-${index}`, isoAt(200 + index), "/busy"));
			}
			for (const file of otherFiles) utimesSync(file, new Date(now - 5_000), new Date(now - 5_000));
			for (const file of busyFiles) utimesSync(file, new Date(now - 60_000), new Date(now - 60_000));
			const read: string[] = [];

			const sessions = await listAllSessions(sessionsRoot, {
				reader: async (filePath) => {
					read.push(filePath);
					return readSessionInfo(filePath);
				},
			});

			expect(read).toHaveLength(DEFAULT_MAX_ALL_SESSIONS);
			expect(sessions).toHaveLength(DEFAULT_MAX_ALL_SESSIONS);
			// The other project's sessions share the window with the busy project's
			// instead of being pushed out by it.
			expect(sessions.map((session) => session.id)).toEqual(expect.arrayContaining(["other-0", "other-1"]));
		});

		it("caps read attempts when the candidates are unreadable", async () => {
			const sessionsRoot = join(dir, "sessions");
			const projectDir = join(sessionsRoot, "--repo--");
			mkdirSync(projectDir, { recursive: true });
			for (let index = 0; index < DEFAULT_MAX_ALL_SESSIONS + 3; index += 1) {
				writeFileSync(join(projectDir, fileNameFor(index, `corrupt-${index}`)), "not a session line\n");
			}
			let reads = 0;

			const sessions = await listAllSessions(sessionsRoot, {
				reader: async () => {
					reads += 1;
					return undefined;
				},
			});

			expect(reads).toBe(DEFAULT_MAX_ALL_SESSIONS);
			expect(sessions).toEqual([]);
		});

		it("reads only the window plus the pinned current session on a large synthetic store", async () => {
			const sessionsRoot = join(dir, "sessions");
			for (let project = 0; project < 12; project += 1) {
				const projectDir = join(sessionsRoot, `--repo-${String(project).padStart(2, "0")}--`);
				mkdirSync(projectDir, { recursive: true });
				for (let index = 0; index < 10; index += 1) {
					const offset = project * 10 + index;
					const id = `p${project}-${index}`;
					writeSession(join(projectDir, fileNameFor(offset, id)), id, isoAt(offset), `/repo-${project}`);
				}
			}
			// The current session is the oldest-named file in the oldest project.
			const currentFile = join(sessionsRoot, "--repo-00--", fileNameFor(0, "p0-0"));
			const read: string[] = [];

			const sessions = await listAllSessions(sessionsRoot, {
				maxSessions: 5,
				currentSessionFile: currentFile,
				reader: async (filePath) => {
					read.push(filePath);
					return readSessionInfo(filePath);
				},
			});

			// Five window reads, then one bounded read to pin the current session.
			expect(read).toHaveLength(6);
			expect(new Set(read).size).toBe(6);
			expect(read).toContain(currentFile);
			expect(sessions).toHaveLength(5);
			expect(sessions.map((session) => session.id)).toContain("p0-0");
		});

		it("bounds a default all-sessions scan by DEFAULT_MAX_ALL_SESSIONS", async () => {
			const sessionsRoot = join(dir, "sessions");
			const projectDir = join(sessionsRoot, "--repo--");
			mkdirSync(projectDir, { recursive: true });
			for (let index = 0; index < DEFAULT_MAX_ALL_SESSIONS + 3; index += 1) {
				writeSession(join(projectDir, fileNameFor(index, `bulk-${index}`)), `bulk-${index}`, isoAt(index));
			}
			let reads = 0;

			const sessions = await listAllSessions(sessionsRoot, {
				reader: async (filePath) => {
					reads += 1;
					return readSessionInfo(filePath);
				},
			});

			expect(reads).toBe(DEFAULT_MAX_ALL_SESSIONS);
			expect(sessions).toHaveLength(DEFAULT_MAX_ALL_SESSIONS);
		});

		it("returns an empty list for a missing sessions root", async () => {
			expect(await listAllSessions(join(dir, "does-not-exist"))).toEqual([]);
		});

		describe("listAllSessionsForSession", () => {
			it("scans a flat custom session directory directly, never its parent", async () => {
				const customDir = join(dir, "custom-sessions");
				mkdirSync(customDir, { recursive: true });
				const currentFile = writeSession(join(customDir, fileNameFor(0, "current")), "current", isoAt(0), "/repo");
				writeSession(join(customDir, fileNameFor(1, "sibling")), "sibling", isoAt(1), "/other-repo");
				// Contamination bait: a sibling of the custom dir, which the old
				// `dirname(sessionDir)` scan would have walked as a project directory.
				const baitDir = join(dir, "--bait--");
				mkdirSync(baitDir, { recursive: true });
				writeSession(join(baitDir, fileNameFor(2, "bait")), "bait", isoAt(2), "/bait");

				const { sessions, truncated } = await listAllSessionsForSession(currentFile);

				expect(sessions.map((session) => session.id)).toEqual(["sibling", "current"]);
				expect(truncated).toBe(false);
			});

			it("keeps the nested layout scanning the project root", async () => {
				const sessionsRoot = join(dir, "sessions");
				const currentDir = join(sessionsRoot, "--repo--");
				const otherDir = join(sessionsRoot, "--other--");
				mkdirSync(currentDir, { recursive: true });
				mkdirSync(otherDir, { recursive: true });
				const currentFile = writeSession(join(currentDir, fileNameFor(0, "current")), "current", isoAt(0), "/repo");
				writeSession(join(otherDir, fileNameFor(1, "other")), "other", isoAt(1), "/repo-other");

				const { sessions } = await listAllSessionsForSession(currentFile);

				expect(sessions.map((session) => session.id)).toEqual(["other", "current"]);
			});

			it("bounds a flat custom session directory scan", async () => {
				const customDir = join(dir, "custom-sessions");
				mkdirSync(customDir, { recursive: true });
				const currentFile = writeSession(join(customDir, fileNameFor(0, "current")), "current", isoAt(0), "/repo");
				for (let index = 1; index <= DEFAULT_MAX_ALL_SESSIONS + 3; index += 1) {
					writeSession(join(customDir, fileNameFor(index, `bulk-${index}`)), `bulk-${index}`, isoAt(index), "/repo");
				}
				let reads = 0;

				const { sessions, truncated } = await listAllSessionsForSession(currentFile, {
					reader: async (filePath) => {
						reads += 1;
						return readSessionInfo(filePath);
					},
				});

				// One layout-detection read plus the capped window (the current
				// session is outside it but pinned from the detected info).
				expect(reads).toBe(DEFAULT_MAX_ALL_SESSIONS + 1);
				expect(sessions).toHaveLength(DEFAULT_MAX_ALL_SESSIONS);
				expect(sessions.map((session) => session.id)).toContain("current");
				// The cap dropped candidates, so the picker must say the list is a window.
				expect(truncated).toBe(true);
			});
			it("reports whether the capped window had to pin the current session", async () => {
				const projectDir = join(dir, "sessions", "--repo--");
				mkdirSync(projectDir, { recursive: true });
				const write = (offsetMinutes: number, id: string): string => {
					const file = writeSession(join(projectDir, fileNameFor(offsetMinutes, id)), id, isoAt(offsetMinutes), "/repo");
					// Candidate ranking reads file mtimes, so pin them explicitly rather
					// than relying on write order.
					const stamp = new Date(Date.UTC(2026, 6, 2, 20, offsetMinutes));
					utimesSync(file, stamp, stamp);
					return file;
				};
				// Stamped oldest, so the current session is outside the newest-100 window.
				const currentFile = write(0, "current");
				for (let index = 1; index <= DEFAULT_MAX_ALL_SESSIONS; index += 1) write(index, `bulk-${index}`);

				const pinnedWindow = await listAllSessionsForSession(currentFile);

				expect(pinnedWindow.truncated).toBe(true);
				expect(pinnedWindow.pinnedCurrent).toBe(true);
				expect(pinnedWindow.sessions.map((session) => session.id)).toContain("current");

				// The newest session is inside the window already, so the same cap drops
				// candidates without pinning anything.
				const newestFile = write(DEFAULT_MAX_ALL_SESSIONS + 1, "newest");
				const windowed = await listAllSessionsForSession(newestFile);

				expect(windowed.truncated).toBe(true);
				expect(windowed.pinnedCurrent).toBe(false);
				expect(windowed.sessions.map((session) => session.id)).toContain("newest");
			});
		});
	});

	describe("listProjectSessions", () => {
		/** A session whose message timestamp is `minute` past 20:00 (sets `modified`). */
		const write = (file: string, id: string, cwd: string, minute: number): string => {
			const timestamp = new Date(Date.UTC(2026, 6, 2, 20, minute)).toISOString();
			writeFileSync(file, jsonl([
				{ type: "session", version: 3, id, timestamp, cwd },
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp,
					message: { role: "user", content: `first ${id}`, timestamp: Date.UTC(2026, 6, 2, 20, minute) },
				},
			]));
			return file;
		};

		it("narrows a flat custom session directory to the current session's cwd", async () => {
			const customDir = join(dir, "custom-sessions");
			mkdirSync(customDir, { recursive: true });
			const currentFile = write(join(customDir, "current.jsonl"), "current", "/repo", 0);
			write(join(customDir, "same-project.jsonl"), "same-project", "/repo", 1);
			write(join(customDir, "other-project.jsonl"), "other-project", "/other-repo", 2);

			const sessions = await listProjectSessions(currentFile);

			expect(sessions.map((session) => session.id)).toEqual(["same-project", "current"]);
		});

		it("keeps every session of a project directory (the default layout is not cwd-filtered)", async () => {
			const projectDir = join(dir, "sessions", "--repo--");
			mkdirSync(projectDir, { recursive: true });
			const currentFile = write(join(projectDir, "current.jsonl"), "current", "/repo", 0);
			write(join(projectDir, "same-project.jsonl"), "same-project", "/repo", 1);
			// Pi filters by cwd only for a custom session dir, so a project
			// directory still lists a session whose header names another cwd.
			write(join(projectDir, "elsewhere.jsonl"), "elsewhere", "/elsewhere", 2);

			const sessions = await listProjectSessions(currentFile);

			expect(sessions.map((session) => session.id)).toEqual(["elsewhere", "same-project", "current"]);
		});

		it("shows no rows for a flat custom session directory when the current file is unreadable", async () => {
			const customDir = join(dir, "custom-sessions");
			mkdirSync(customDir, { recursive: true });
			// A fresh or corrupt current file has no header, so there is no cwd to
			// filter the shared directory by. "current project" must not fall back
			// to every readable sibling -- those rows are other projects'.
			const currentFile = join(customDir, "current.jsonl");
			write(join(customDir, "same-project.jsonl"), "same-project", "/repo", 1);
			write(join(customDir, "other-project.jsonl"), "other-project", "/other-repo", 2);

			expect(await listProjectSessions(currentFile)).toEqual([]);
		});

		it("keeps a project directory's rows when the current file is unreadable", async () => {
			const projectDir = join(dir, "sessions", "--repo--");
			mkdirSync(projectDir, { recursive: true });
			// The encoded name is the nested default layout's signal, so the
			// directory is still this project's scope with no header to read.
			const currentFile = join(projectDir, "current.jsonl");
			write(join(projectDir, "same-project.jsonl"), "same-project", "/repo", 1);

			const sessions = await listProjectSessions(currentFile);

			expect(sessions.map((session) => session.id)).toEqual(["same-project"]);
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
