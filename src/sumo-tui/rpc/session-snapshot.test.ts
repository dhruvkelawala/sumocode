import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CHILD_JSON_FRAME_MAX_BYTES } from "../../child-protocol.js";
import { readAuthoritativeSessionSnapshot, readPersistedSessionMessages } from "./session-snapshot.js";
import type { SessionEntryLike } from "./session-reader.js";

interface DiskFileFixture {
	dir: string;
	file: string;
}

function diskFile(entries: readonly SessionEntryLike[], sessionId = "session-1"): DiskFileFixture {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-session-snapshot-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-04T00:00:00.000Z", cwd: "/repo" }),
		...entries.map((value) => JSON.stringify(value)),
		"",
	].join("\n"));
	return { dir, file };
}

function entry(id: string, parentId: string | null = null): SessionEntryLike {
	return { type: "message", id, parentId, timestamp: "2026-08-04T00:00:01.000Z", message: { role: "user", content: id } };
}

describe("authoritative flat session snapshots", () => {
	it("merges an exclusive delta and keeps its authoritative leaf", async () => {
		const original = [entry("one")];
		const { dir, file } = diskFile(original);
		try {
			const calls: (string | undefined)[] = [];
			const result = await readAuthoritativeSessionSnapshot({
				getEntries: async (since) => {
					calls.push(since);
					return { entries: [entry("two", "one")], leafId: "two" };
				},
			}, { sessionFile: file, sessionId: "session-1" });
			expect(calls).toEqual(["one"]);
			expect(result.entries.map((value) => value.id)).toEqual(["one", "two"]);
			expect(result.leafId).toBe("two");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["missing file", { sessionFile: "/missing/session.jsonl", sessionId: "session-1", empty: false }],
		["empty disk", { sessionFile: undefined, sessionId: "session-1", empty: true }],
		["header mismatch", { sessionFile: undefined, sessionId: "other", empty: false }],
	] as const)("uses one full fallback for %s", async (_name, options) => {
		const { dir, file } = diskFile(options.empty ? [] : [entry("one")]);
		try {
			const calls: (string | undefined)[] = [];
			const result = await readAuthoritativeSessionSnapshot({
				getEntries: async (since) => {
					calls.push(since);
					return { entries: [entry("full")], leafId: "full" };
				},
			}, { sessionFile: options.sessionFile === "/missing/session.jsonl" ? options.sessionFile : file, sessionId: options.sessionId });
			expect(calls).toEqual([undefined]);
			expect(result.entries.map((value) => value.id)).toEqual(["full"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the steady-state long-session delta response bounded", async () => {
		const entries = Array.from({ length: 6_001 }, (_, index) => entry(`long-${index}`, index === 0 ? null : `long-${index - 1}`));
		const { dir, file } = diskFile(entries);
		try {
			const calls: (string | undefined)[] = [];
			const result = await readAuthoritativeSessionSnapshot({
				getEntries: async (since) => {
					calls.push(since);
					return { entries: [], leafId: "long-6000" };
				},
			}, { sessionFile: file, sessionId: "session-1" });
			expect(calls).toEqual(["long-6000"]);
			expect(result.entries).toHaveLength(6_001);
			expect(JSON.stringify({ entries: [], leafId: result.leafId }).length).toBeLessThan(4_096);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hydrates message history larger than one RPC frame through a bounded delta", async () => {
		const large = "x".repeat(CHILD_JSON_FRAME_MAX_BYTES);
		const persisted = entry("large");
		const { dir, file } = diskFile([{ ...persisted, message: { role: "user", content: large } }]);
		try {
			const calls: (string | undefined)[] = [];
			const messages = await readPersistedSessionMessages({
				getEntries: async (since) => {
					calls.push(since);
					return { entries: [], leafId: "large" };
				},
			}, { sessionFile: file, sessionId: "session-1" });
			if (!messages) throw new Error("expected persisted messages");
			expect(calls).toEqual(["large"]);
			expect(Buffer.byteLength(JSON.stringify(messages), "utf8")).toBeGreaterThan(CHILD_JSON_FRAME_MAX_BYTES);
			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("user");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps compaction and branch selection when rebuilding messages", async () => {
		const entries: SessionEntryLike[] = [
			entry("old"),
			{ type: "compaction", id: "summary", parentId: "old", timestamp: "2026-08-04T00:00:02.000Z", summary: "older work", firstKeptEntryId: "kept", tokensBefore: 100 },
			entry("kept", "summary"),
			entry("chosen", "kept"),
			entry("sibling", "kept"),
		];
		const { dir, file } = diskFile(entries);
		try {
			const messages = await readPersistedSessionMessages({
				getEntries: async () => ({ entries: [], leafId: "chosen" }),
			}, { sessionFile: file, sessionId: "session-1" });
			if (!messages) throw new Error("expected persisted messages");
			const encoded = JSON.stringify(messages);
			expect(encoded).toContain("older work");
			expect(encoded).toContain("kept");
			expect(encoded).toContain("chosen");
			expect(encoded).not.toContain('"content":"old"');
			expect(encoded).not.toContain("sibling");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not request all entries when the disk cursor is stale", async () => {
		const { dir, file } = diskFile([entry("one")]);
		try {
			const calls: (string | undefined)[] = [];
			const messages = await readPersistedSessionMessages({
				getEntries: async (since) => {
					calls.push(since);
					throw new Error("get_entries failed: Entry not found: one");
				},
			}, { sessionFile: file, sessionId: "session-1" });
			expect(messages).toBeUndefined();
			expect(calls).toEqual(["one"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back once for Pi's cursor-not-found error", async () => {
		const { dir, file } = diskFile([entry("one")]);
		try {
			const calls: (string | undefined)[] = [];
			const result = await readAuthoritativeSessionSnapshot({
				getEntries: async (since) => {
					calls.push(since);
					if (since) throw new Error("get_entries failed: Entry not found: one");
					return { entries: [entry("full")], leafId: "full" };
				},
			}, { sessionFile: file, sessionId: "session-1" });
			expect(calls).toEqual(["one", undefined]);
			expect(result.leafId).toBe("full");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fall back for an unrelated missing entry", async () => {
		const { dir, file } = diskFile([entry("one")]);
		try {
			const calls: (string | undefined)[] = [];
			await expect(readAuthoritativeSessionSnapshot({
				getEntries: async (since) => {
					calls.push(since);
					if (since) throw new Error("get_entries failed: Entry not found: another-cursor");
					return { entries: [entry("full")], leafId: "full" };
				},
			}, { sessionFile: file, sessionId: "session-1" })).rejects.toThrow("another-cursor");
			expect(calls).toEqual(["one"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("propagates unrelated delta failures without a full retry", async () => {
		const { dir, file } = diskFile([entry("one")]);
		try {
			const calls: (string | undefined)[] = [];
			await expect(readAuthoritativeSessionSnapshot({
				getEntries: async (since) => {
					calls.push(since);
					throw new Error("child exited");
				},
			}, { sessionFile: file, sessionId: "session-1" })).rejects.toThrow("child exited");
			expect(calls).toEqual(["one"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects duplicate IDs while merging", async () => {
		const { dir, file } = diskFile([entry("one")]);
		try {
			await expect(readAuthoritativeSessionSnapshot({
				getEntries: async () => ({ entries: [entry("one")], leafId: "one" }),
			}, { sessionFile: file, sessionId: "session-1" })).rejects.toThrow(/duplicate/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});