import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const checker = join(import.meta.dirname, "check-dependency-audit.mjs");

function runChecker(audit, records) {
	const directory = mkdtempSync(join(tmpdir(), "sumocode-audit-test-"));
	const auditPath = join(directory, "audit.json");
	const policyPath = join(directory, "policy.json");
	writeFileSync(auditPath, JSON.stringify({ advisories: audit }));
	writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, records }));
	return spawnSync(process.execPath, [checker, "--audit", auditPath, "--policy", policyPath], {
		encoding: "utf8",
	});
}

function advisory(id, severity = "high", path = ".>@earendil-works/pi-ai>example") {
	return {
		id,
		module_name: "example",
		severity,
		findings: [{ version: "1.0.0", paths: [path] }],
	};
}

describe("dependency audit policy", () => {
	it("requires every high or critical advisory to be explicitly upstream-blocked", () => {
		const finding = advisory(101);
		const unclassified = runChecker({ 101: finding }, []);
		expect(unclassified.status).toBe(1);
		expect(unclassified.stderr).toContain("unclassified high advisory 101");

		const classified = runChecker({ 101: finding }, [
			{
				advisories: [101],
				package: "example",
				scope: "consumer-runtime",
				status: "upstream-blocked",
				owner: "maintainer",
				expires: "2999-01-01",
			},
		]);
		expect(classified.status).toBe(0);
		expect(classified.stdout).toContain("consumer-runtime upstream-blocked: 1");
	});
});
