import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const checker = join(import.meta.dirname, "check-dependency-audit.mjs");

function runChecker(audit, records, schemaVersion = 1) {
	const directory = mkdtempSync(join(tmpdir(), "sumocode-audit-test-"));
	const auditPath = join(directory, "audit.json");
	const policyPath = join(directory, "policy.json");
	writeFileSync(auditPath, JSON.stringify({ advisories: audit }));
	writeFileSync(policyPath, JSON.stringify({ schemaVersion, records }));
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

function record(advisories = [101]) {
	return {
		advisories,
		package: "example",
		scope: "consumer-runtime",
		status: "upstream-blocked",
		owner: "maintainer",
		expires: "2999-01-01",
	};
}

describe("dependency audit policy", () => {
	it("runs in the required CI lane", () => {
		const workflow = readFileSync(join(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");
		expect(workflow).toContain("run: node scripts/check-dependency-audit.mjs");
	});

	it("rejects unknown policy schemas", () => {
		const result = runChecker({}, [], 2);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unsupported policy schema 2");
	});

	it("requires every high or critical advisory to be explicitly upstream-blocked", () => {
		const finding = advisory(101);
		const unclassified = runChecker({ 101: finding }, []);
		expect(unclassified.status).toBe(1);
		expect(unclassified.stderr).toContain("unclassified high advisory 101");

		const classified = runChecker({ 101: finding }, [record()]);
		expect(classified.status).toBe(0);
		expect(classified.stdout).toContain("consumer-runtime upstream-blocked: 1");
		expect(classified.stdout).toContain("local-development high/critical: 0");
	});

	it.each([
		["stale", {}, [record()], "stale policy advisory 101"],
		["expired", { 101: advisory(101) }, [{ ...record(), expires: "2000-01-01" }], "expired policy advisory 101"],
		["unremediated", { 101: advisory(101) }, [{ ...record(), status: "accepted-risk" }], "unremediated high advisory 101"],
	])("rejects %s policy records", (_name, audit, records, message) => {
		const result = runChecker(audit, records);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(message);
	});

	it.each([
		["ownerless", advisory(101), [{ ...record(), owner: "" }], "missing owner for advisory 101"],
		["invalid expiry", advisory(101), [{ ...record(), expires: "later" }], "invalid expiry for advisory 101"],
		["wrong package", advisory(101), [{ ...record(), package: "other" }], "package mismatch for advisory 101"],
		["local path", advisory(101, "high", ".>vitest>vite"), [record()], "non-consumer path for advisory 101"],
		["duplicate", advisory(101), [record(), record()], "duplicate policy advisory 101"],
	])("rejects %s upstream-blocked records", (_name, finding, records, message) => {
		const result = runChecker({ 101: finding }, records);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(message);
	});
});
