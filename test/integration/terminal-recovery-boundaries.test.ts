import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../../src/background-tasks/process-tree.js";
import { cleanupOwnedTree, publishMarker, type OwnedTree } from "./fixtures/terminal-recovery-boundaries.js";
import "./harness-supervisor.js";

const boundary = vi.hoisted(() => ({ observe: () => {} }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- inject a partial OS write without adding a production filesystem adapter solely for this race.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			// Expose a deterministic partial write at the actual filesystem boundary.
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- fs accepts paths or descriptors; preserve the descriptor offset during injection.
			if (typeof args[0] === "number") fs.writeSync(args[0], "{", 0);
			else fs.writeFileSync(args[0], "{", args[2]);
			boundary.observe();
			return fs.writeFileSync(...args);
		},
	};
});

const roots: string[] = [];
afterEach(() => {
	boundary.observe = () => {};
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("terminal recovery fixture boundaries", () => {
	it("publishes only complete JSON, including replacement records", () => {
		const root = mkdtempSync(join(tmpdir(), "terminal-marker-boundary-"));
		roots.push(root);
		const marker = join(root, "index-attempt.json");
		boundary.observe = () => expect(existsSync(marker)).toBe(false);
		publishMarker(marker, { ready: false });
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ ready: false });
		boundary.observe = () => expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ ready: false });
		publishMarker(marker, { ready: true });
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ ready: true });
		boundary.observe = () => { throw new Error("interrupted publication"); };
		expect(() => publishMarker(marker, { ready: false })).toThrow("interrupted publication");
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ ready: true });
	});

	const tree: OwnedTree = {
		identity: { pid: 123, processGroupId: 123, processStartTime: "original-leader" },
		verification: { members: [{ pid: 124, processStartTime: "original-child" }] },
	};
	function operations(): ProcessTreeOperations {
		return {
			captureStartTime: () => undefined,
			identityMatches: () => "unknown",
			captureTreeVerification: vi.fn(() => undefined),
			verificationMatches: () => "same",
			isTreeEmpty: () => false,
			signalTree: vi.fn(async () => ({ ok: true, gone: false })),
			waitForTreeEmpty: async () => true,
		};
	}
	it("uses durable descendant anchors without recapturing an exited leader", async () => {
		const ops = operations();
		expect(await cleanupOwnedTree(ops, tree)).toBe(true);
		expect(ops.captureTreeVerification).not.toHaveBeenCalled();
		expect(ops.signalTree).toHaveBeenCalledExactlyOnceWith(tree.identity, "SIGTERM", tree.verification);
	});
	it("accepts exit during verified signal only with independent empty-tree proof", async () => {
		const ops = operations();
		ops.signalTree = vi.fn(async () => ({ ok: false, gone: false, identityStatus: "different" as const }));
		ops.isTreeEmpty = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
		expect(await cleanupOwnedTree(ops, tree)).toBe(true);
		expect(ops.signalTree).toHaveBeenCalledTimes(1);
	});
	for (const status of ["different", "unknown"] as const) it(`refuses a ${status} nonempty tree`, async () => {
		const ops = operations();
		ops.identityMatches = () => status;
		ops.verificationMatches = () => status;
		expect(await cleanupOwnedTree(ops, tree)).toBe(false);
		expect(ops.signalTree).not.toHaveBeenCalled();
	});
	it("refuses an unanchored nonempty tree after leader exit", async () => {
		const ops = operations();
		expect(await cleanupOwnedTree(ops, { identity: tree.identity })).toBe(false);
		expect(ops.captureTreeVerification).not.toHaveBeenCalled();
		expect(ops.signalTree).not.toHaveBeenCalled();
	});
	it("escalates only with the original anchors and fails if still alive", async () => {
		const ops = operations();
		ops.waitForTreeEmpty = async () => false;
		expect(await cleanupOwnedTree(ops, tree)).toBe(false);
		expect(ops.signalTree).toHaveBeenNthCalledWith(1, tree.identity, "SIGTERM", tree.verification);
		expect(ops.signalTree).toHaveBeenNthCalledWith(2, tree.identity, "SIGKILL", tree.verification);
	});
	it("preserves refusal at the signal boundary while the tree is nonempty", async () => {
		const ops = operations();
		ops.signalTree = vi.fn(async () => ({ ok: false, gone: false, identityStatus: "different" as const }));
		expect(await cleanupOwnedTree(ops, tree)).toBe(false);
	});
});
