import * as fs from "node:fs";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { prepareRetainedBootstrap, readRetainedBootstrap, type RetainedBootstrapConfiguration } from "./retained-bootstrap.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- OS boundary: only foreign ownership is injected; private fixture files are real.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
afterEach(() => { vi.restoreAllMocks(); });

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-bootstrap-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const pi = join(root, "pi");
	writeFileSync(pi, "public executable fixture", { mode: 0o755 });
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-proof", ownerSessionId: "session-a",
		backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null,
		modelLabel: "provider/model", roleId: null, createdAt: 1000, updatedAt: 1000, settledAt: null,
		completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const registry = new SubagentRegistry(join(root, "registry"), record.ownerSessionId);
	registry.create(record);
	const config: RetainedBootstrapConfiguration = {
		cwd: root, baseRef: "HEAD", model: { provider: "provider", modelId: "model", label: "provider/model" },
		thinking: "low", builtInTools: ["read"], role: null, pi,
		adapterEntry: null, modelBootstrapEntry: null, visible: null,
	};
	return { root, record, registry, config };
}

const secrets = { prompt: "private prompt 🦉\nsecond line", systemPrompt: "private system instruction" };

describe("retained bootstrap private protocol", () => {
	it.each(["id", "ownerSessionId", "taskDir", "nonce"] as const)("rejects a mismatched expected %s", (field) => {
		const { root, record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		const otherTask = join(root, "other-task");
		mkdirSync(otherTask, { mode: 0o700 });
		const expected = { ...record, [field]: field === "taskDir" ? otherTask : "sa-other" };
		expect(() => readRetainedBootstrap(expected, field === "nonce" ? "00000000-0000-4000-8000-000000000000" : descriptor.nonce)).toThrow("unsafe retained bootstrap");
	});

	it.each([
		{ schemaVersion: 99 }, { schemaVersion: undefined }, { id: "sa-other" }, { ownerSessionId: "other-session" },
		{ taskDir: "/outside" }, { nonce: "00000000-0000-4000-8000-000000000000" },
		{ backend: ["headless"] }, { extra: "private system instruction" }, { "": "private prompt" },
		{ prompt: { file: "../outside", bytes: 3, sha256: "0".repeat(64) } },
		{ systemPrompt: { file: "bootstrap-prompt.json", bytes: 3, sha256: "0".repeat(64) } },
	])("rejects descriptor schema/binding tamper %# with redacted errors", (patch) => {
		const { record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		writeFileSync(join(record.taskDir, "bootstrap.json"), JSON.stringify({ ...descriptor, ...patch }));
		try {
			readRetainedBootstrap(record, descriptor.nonce);
			expect.fail("tamper was accepted");
		} catch (error) {
			expect(error).toEqual(new Error("unsafe retained bootstrap"));
			expect(String(error)).not.toContain(secrets.systemPrompt);
		}
	});

	it.each([
		{ thinking: "inherit" }, { builtInTools: ["mcp"] }, { builtInTools: ["read", "read"] },
		{ model: null }, { model: { provider: "p", modelId: "m", label: "different" } },
		{ role: { id: "review", label: "review", systemPrompt: "private system instruction" } },
		{ adapterEntry: "relative.ts" }, { pi: "pi" }, { visible: {} }, { appendSystemPrompt: "private system instruction" },
	])("rejects unresolved or extra configuration %# before writing", (patch) => {
		const { record, config } = fixture();
		Object.assign(config, patch);
		expect(() => prepareRetainedBootstrap(record, config, secrets)).toThrow("unsafe retained bootstrap");
		expect(readdirSync(record.taskDir)).toEqual([]);
	});

	it.each(["bootstrap.json", "bootstrap-prompt.json", "bootstrap-system-prompt.json"])("rejects unsafe %s mode, symlink, oversize, and malformed UTF-8", (file) => {
		const { record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		const path = join(record.taskDir, file);
		chmodSync(path, 0o644);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		chmodSync(path, 0o600);
		writeFileSync(path, Buffer.alloc(2 * 1024 * 1024));
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		writeFileSync(path, Buffer.from([0x22, 0xff, 0x22]));
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		renameSync(path, `${path}.preserved`);
		symlinkSync(`${path}.preserved`, path);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
	});

	it.each(["task", "bootstrap.json", "bootstrap-prompt.json", "bootstrap-system-prompt.json"])("rejects foreign-owned %s", (file) => {
		const { record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		const path = file === "task" ? record.taskDir : join(record.taskDir, file);
		const lstat = fs.lstatSync;
		vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
			const stat = lstat(...args);
			if (stat && args[0] === path) stat.uid = Number(stat.uid) + 1;
			return stat;
		});
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
	});

	it("rejects private directory widening and ancestor symlink redirection", () => {
		const { root, record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		chmodSync(record.taskDir, 0o750);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		chmodSync(record.taskDir, 0o700);
		renameSync(root, `${root}-preserved`);
		symlinkSync(`${root}-preserved`, root);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
	});

	it.each(["prompt", "systemPrompt"] as const)("bounds %s text bytes and rejects invalid Unicode before writing", (field) => {
		const { record, config } = fixture();
		for (const text of ["a".repeat(256 * 1024 + 1), "🦉".repeat(65537), "\ud800", "nul\0text"]) {
			expect(() => prepareRetainedBootstrap(record, config, { ...secrets, [field]: text })).toThrow("unsafe retained bootstrap");
			expect(readdirSync(record.taskDir)).toEqual([]);
		}
	});

	it("supports the exact byte cap, empty tool allowlist, and absent optional system/role/code", () => {
		const { record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, { ...config, builtInTools: [] }, { prompt: "\t".repeat(256 * 1024), systemPrompt: null });
		const loaded = readRetainedBootstrap(record, descriptor.nonce);
		expect(Buffer.byteLength(loaded.prompt)).toBe(256 * 1024);
		expect(loaded.systemPrompt).toBeNull();
		expect(loaded.descriptor.config.builtInTools).toEqual([]);
		expect(loaded.descriptor.config.role).toBeNull();
		expect(loaded.descriptor.config.adapterEntry).toBeNull();
		expect(readdirSync(record.taskDir).sort()).toEqual(["bootstrap-prompt.json", "bootstrap.json"]);
		for (const file of readdirSync(record.taskDir)) expect(statSync(join(record.taskDir, file)).mode & 0o777).toBe(0o600);
		expect(() => prepareRetainedBootstrap(record, config, secrets)).toThrow("unsafe retained bootstrap");
	});

	it.each(["bootstrap.json", "bootstrap-prompt.json", "bootstrap-system-prompt.json"])("rejects missing committed %s without repair", (file) => {
		const { record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		const path = join(record.taskDir, file);
		renameSync(path, `${path}.preserved`);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		expect(readdirSync(record.taskDir)).not.toContain(file);
	});

	it("does not reinterpret a later writer grant as bootstrap authority or reload configuration", () => {
		const { record, registry, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		const owned = registry.acquireWriter(record.id, record.revision, 60000);
		const loaded = readRetainedBootstrap(owned, descriptor.nonce);
		expect(loaded.descriptor).toEqual(descriptor);
		expect(loaded.descriptor).not.toHaveProperty("writerLease");
		expect(registry.get(record.id)).toEqual(owned);
	});

	it("detects changed same-size prompt bytes and never includes parser content in errors", () => {
		const { record, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		const path = join(record.taskDir, "bootstrap-prompt.json");
		writeFileSync(path, readFileSync(path, "utf8").replace("private", "changed"));
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		writeFileSync(join(record.taskDir, "bootstrap.json"), `invalid ${secrets.systemPrompt}`);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow(/^unsafe retained bootstrap$/u);
	});

	it("rejects already-owned starting records without changing the registry", () => {
		const { record, registry, config } = fixture();
		const owned = registry.acquireWriter(record.id, record.revision, 60000);
		expect(() => prepareRetainedBootstrap(owned, config, secrets)).toThrow("unsafe retained bootstrap");
		expect(registry.get(record.id)).toEqual(owned);
		expect(readdirSync(record.taskDir)).toEqual([]);
	});

	it.each(["workspace", "tab", "new-tab"] as const)("preserves visible %s placement, worktree, resolved role and public entries", (kind) => {
		const { root, record, registry, config } = fixture();
		const entry = join(root, "trusted.ts");
		writeFileSync(entry, "public code", { mode: 0o644 });
		const placement = kind === "workspace" ? { kind, workspaceId: "workspace-a" }
			: kind === "tab" ? { kind, tabId: "tab-a", direction: "down" as const } : { kind, label: "worker-tab" };
		const initial = registry.create({ ...record, id: "sa-visible", backend: "visible", roleId: "review", worktree: { path: root, repoRoot: root, branch: "feature", baseRef: "HEAD" } });
		const descriptor = prepareRetainedBootstrap(initial, { ...config, role: { id: "review", label: "reviewer" },
			adapterEntry: entry, modelBootstrapEntry: entry, visible: { name: "worker", placement, launcher: config.pi } }, secrets);
		const loaded = readRetainedBootstrap(initial, descriptor.nonce);
		expect(loaded.descriptor.worktree).toEqual(initial.worktree);
		expect(loaded.descriptor.config.visible).toEqual({ name: "worker", placement, launcher: config.pi });
		expect(loaded.descriptor.config.role).toEqual({ id: "review", label: "reviewer" });
		expect(loaded.descriptor.config.adapterEntry).toBe(entry);
		expect(loaded.descriptor.config.modelBootstrapEntry).toBe(entry);
	});

	it("refuses private data as executable/code and changed trusted code paths", () => {
		const { root, record, config } = fixture();
		const data = join(record.taskDir, "private-data");
		writeFileSync(data, "private", { mode: 0o700 });
		expect(() => prepareRetainedBootstrap(record, { ...config, adapterEntry: data }, secrets)).toThrow("unsafe retained bootstrap");
		expect(readdirSync(record.taskDir)).toEqual(["private-data"]);
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		chmodSync(config.pi, 0o644);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		chmodSync(config.pi, 0o777);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
		renameSync(config.pi, join(root, "pi-preserved"));
		symlinkSync(join(root, "pi-preserved"), config.pi);
		expect(() => readRetainedBootstrap(record, descriptor.nonce)).toThrow("unsafe retained bootstrap");
	});

	it("refuses a planted optional file before publishing any secret", () => {
		const { root, record, config } = fixture();
		symlinkSync(join(root, "outside"), join(record.taskDir, "bootstrap-system-prompt.json"));
		expect(() => prepareRetainedBootstrap(record, config, { ...secrets, systemPrompt: null })).toThrow("unsafe retained bootstrap");
		expect(readdirSync(record.taskDir)).toEqual(["bootstrap-system-prompt.json"]);
		expect(readdirSync(root).sort()).toEqual(["pi", "registry", "task"]);
	});
	it("rejects coerced placement values rather than accepting an inexact schema", () => {
		const { record, registry, config } = fixture();
		const visible = { ...config, visible: { name: "worker", placement: { kind: "tab" as const, tabId: "tab-a", direction: "right" as const }, launcher: config.pi } };
		const initial = registry.create({ ...record, id: "sa-visible", backend: "visible" });
		const descriptor = prepareRetainedBootstrap(initial, visible, secrets);
		const changed = structuredClone(descriptor);
		Object.assign(changed.config.visible!.placement, { direction: ["right"] });
		writeFileSync(join(record.taskDir, "bootstrap.json"), JSON.stringify(changed));
		expect(() => readRetainedBootstrap(initial, descriptor.nonce)).toThrow("unsafe retained bootstrap");
	});
	it("round-trips resolved inputs without metadata secrets or registry authority", () => {
		const { root, record, registry, config } = fixture();
		const descriptor = prepareRetainedBootstrap(record, config, secrets);
		Object.assign(config, { builtInTools: [] });
		const loaded = readRetainedBootstrap(record, descriptor.nonce);
		expect(loaded.prompt).toBe(secrets.prompt);
		expect(loaded.systemPrompt).toBe(secrets.systemPrompt);
		expect(loaded.descriptor.config.builtInTools).toEqual(["read"]);
		expect(Object.isFrozen(loaded.descriptor.config.builtInTools)).toBe(true);
		expect(registry.get(record.id)).toEqual(record);
		const serialized = readFileSync(join(record.taskDir, "bootstrap.json"), "utf8");
		for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
		expect(readdirSync(record.taskDir).sort()).toEqual(["bootstrap-prompt.json", "bootstrap-system-prompt.json", "bootstrap.json"]);
		expect(readdirSync(root).sort()).toEqual(["pi", "registry", "task"]);
	});
});
