import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { prepareHarnessAdmission } from "./harness-admission.js";
import { afterEach, expect, it, vi } from "vitest";
import {
	createChildEvidenceContext,
	harnessAuditFailures,
	HARNESS_RUN_ID_ENV_KEY,
	HARNESS_SIGNING_KEY_ENV_KEY,
	spawnSupervisedProcess,
	spawnSupervisedPty,
} from "./harness-supervisor.js";

afterEach(() => vi.unstubAllEnvs());

it("rejects an unsigned grant from a substituted admission endpoint", async () => {
	const root = mkdtempSync(join(tmpdir(), "admission-forgery-"));
	const marker = join(root, "workload-executed");
	const args = ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`];
	const admission = prepareHarnessAdmission(process.execPath, args, root);
	const forgedAddress = join(dirname(admission.args[1]!), "forged");
	const forged = createServer((connection) => {
		connection.on("error", () => {});
		connection.end("go");
	});
	try {
		forged.listen(forgedAddress);
		await once(forged, "listening");
		const bootstrapArgs = [...admission.args];
		bootstrapArgs[1] = forgedAddress;
		const child = spawnSupervisedProcess(admission.command, bootstrapArgs, { env: process.env, stdio: "ignore" });
		try {
			const [code] = await once(child.child, "exit");
			expect(code).toBe(1);
			expect(existsSync(marker)).toBe(false);
		} finally {
			await child.terminate();
		}
	} finally {
		await new Promise<void>((resolve) => forged.close(() => resolve()));
		admission.cancel();
	}
});

it.each(["pipe", "pty"] as const)("refuses %s workload execution and exits its bootstrap after registration failure", async (backend) => {
	const root = mkdtempSync(join(tmpdir(), "admission-refusal-"));
	const manifest = join(root, "unwritable-manifest");
	const marker = join(root, "workload-executed");
	mkdirSync(manifest, { mode: 0o700 });
	const auth = { runId: "admission-test", signingKey: "admission-test-key" };
	vi.stubEnv(HARNESS_RUN_ID_ENV_KEY, auth.runId);
	vi.stubEnv(HARNESS_SIGNING_KEY_ENV_KEY, auth.signingKey);
	const env = { ...process.env, SUMOCODE_INTEGRATION_RUN_ROOT: root, SUMOCODE_INTEGRATION_MANIFEST: manifest };
	const args = ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`];
	const evidence = createChildEvidenceContext([process.execPath, ...args], env);

	expect(() => {
		if (backend === "pipe") spawnSupervisedProcess(process.execPath, args, { env, stdio: "ignore" });
		else spawnSupervisedPty(process.execPath, args, { env, cwd: root, cols: 80, rows: 24 }, evidence, auth);
	}).toThrow(/spawn registration failed/);

	const failures = harnessAuditFailures(root);
	const registration = failures.find((failure) => failure.phase === "spawn registration");
	expect(registration).toBeDefined();
	const pid = registration!.pid;
	expect(pid).toBeGreaterThan(0);
	await vi.waitFor(() => {
		let absent = false;
		try { process.kill(pid, 0); }
		catch (error) {
			// SAFETY: kill(0) returns an OS error; only ESRCH proves this PID absent.
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			absent = true;
		}
		expect(absent).toBe(true);
	});
	expect(existsSync(marker)).toBe(false);
	// Refusing admission does not suppress the original registration/audit failure.
	expect(failures).toContainEqual(expect.objectContaining({ phase: "spawn registration cleanup" }));
});
