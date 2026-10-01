// oxlint-disable anti-slop/no-module-mocking -- This unit-only port check replaces OS spawn/admission boundaries so neither real integration processes nor srt start; live ownership contracts remain integration-owned.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
	spawn: vi.fn(() => { throw new Error("spawn boundary"); }),
	listen: vi.fn(),
	admit: vi.fn(() => ({ command: "bootstrap", args: [], cancel: vi.fn() })),
	wrap: vi.fn((command, args, options) => ({ command: "sandbox", args: [command, ...args], env: options.env })),
}));
vi.mock("node:child_process", () => ({ spawn: seam.spawn }));
vi.mock("node-pty", () => ({ spawn: seam.spawn }));
vi.mock("node:net", () => ({ createServer: () => ({ on: vi.fn(), listen: seam.listen, unref: vi.fn(), close: vi.fn() }) }));
vi.mock("../../test/integration/harness-admission.mjs", () => ({ prepareHarnessAdmission: seam.admit }));
vi.mock("../../scripts/preflight-integration.mjs", () => ({ liveProcessStart: () => "synthetic birth", reapHarnessProcessGroup: vi.fn() }));
vi.mock("./wrap-app.mjs", () => ({ wrapTestApp: seam.wrap, createTestAgentDir: vi.fn() }));

import { finalizeFocusedNamespace, spawnSupervisedApp, spawnSupervisedPty } from "../../test/integration/harness-supervisor-core.mjs";
import { buildSpawnEnv } from "../../test/integration/spawn-pi-pty.js";

afterEach(async () => {
	await finalizeFocusedNamespace();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it.each(["", "srt"])("preserves supervised app admission in sandbox mode %j", (mode) => {
	vi.stubEnv("SUMOCODE_TEST_SANDBOX", mode);
	const env = { SYNTHETIC: "kept" };
	expect(() => spawnSupervisedApp("pi", ["a b"], { env }, [43210])).toThrow("spawn boundary");
	expect(seam.admit).toHaveBeenCalledWith(mode ? "sandbox" : "pi", mode ? ["pi", "a b"] : ["a b"], expect.any(String));
	if (mode) expect(seam.wrap).toHaveBeenCalledWith("pi", ["a b"], { cwd: undefined, env, ports: [43210] });
	else expect(seam.wrap).not.toHaveBeenCalled();
});

it.each([false, true])("preserves the PTY sandbox bypass (wrap=%j)", (sandboxApp) => {
	vi.stubEnv("SUMOCODE_TEST_SANDBOX", "srt");
	const options = { env: { SYNTHETIC: "kept" }, cwd: process.cwd() };
	expect(() => spawnSupervisedPty("pi", ["a b"], options, { evidenceDir: "owned-evidence" }, { runId: "test", signingKey: "test" }, sandboxApp)).toThrow("spawn boundary");
	expect(seam.admit).toHaveBeenCalledWith(sandboxApp ? "sandbox" : "pi", sandboxApp ? ["pi", "a b"] : ["a b"], "owned-evidence");
	if (sandboxApp) expect(seam.wrap).toHaveBeenCalledWith("pi", ["a b"], options);
	else expect(seam.wrap).not.toHaveBeenCalled();
});

it.each(["", "srt"])("keeps admission socket placement in the ESM implementation (mode=%j)", async (mode) => {
	vi.stubEnv("SUMOCODE_TEST_SANDBOX", mode);
	const { prepareHarnessAdmission } = await vi.importActual("../../test/integration/harness-admission.mjs");
	const root = mkdtempSync(join(tmpdir(), "sumocode-admission-port-"));
	const admission = prepareHarnessAdmission("pi", ["a b"], root);
	const address = admission.args[1];
	try {
		expect(isAbsolute(address)).toBe(true);
		expect(dirname(address).startsWith(mode ? tmpdir() : process.platform === "darwin" ? "/private/tmp" : "/tmp")).toBe(true);
		expect(seam.listen).toHaveBeenCalledWith(mode ? relative(process.cwd(), address) : address);
		expect(admission.args.slice(-2)).toEqual(["pi", "a b"]);
	} finally {
		admission.cancel();
		rmSync(dirname(address), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps the native fixture agent ahead of generic run-scoped trust defaults", () => {
	const root = mkdtempSync(join(tmpdir(), "sumocode-native-port-"));
	try {
		const env = buildSpawnEnv({ SUMOCODE_INTEGRATION_RUN_ROOT: root }, undefined, { agentDir: root, roots: [root] });
		expect(env.PI_CODING_AGENT_DIR).toBe(root);
		expect(env.SUMOCODE_CONFIG_DIR).toBe(join(root, "config"));
		expect(seam.wrap).not.toHaveBeenCalled();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
