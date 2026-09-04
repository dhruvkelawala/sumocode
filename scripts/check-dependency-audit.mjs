#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index === -1) return fallback;
	if (!process.argv[index + 1]) throw new Error(`missing ${name}`);
	return process.argv[index + 1];
}

function readAudit() {
	const path = argument("--audit");
	if (path) return JSON.parse(readFileSync(path, "utf8"));
	const result = spawnSync("pnpm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
	if (result.status !== 0 && result.status !== 1) {
		throw new Error(`pnpm audit failed: ${result.stderr.trim() || `exit ${result.status}`}`);
	}
	return JSON.parse(result.stdout);
}

try {
	const audit = readAudit();
	if (audit.error) {
		const message = audit.error.summary ?? audit.error.message ?? audit.error.code ?? String(audit.error);
		throw new Error(`pnpm audit error: ${message}`);
	}
	if (audit.advisories?.constructor !== Object) {
		throw new Error("pnpm audit response is missing advisories");
	}
	const policyPath = argument("--policy", join(import.meta.dirname, "dependency-audit-policy.json"));
	const policy = JSON.parse(readFileSync(policyPath, "utf8"));
	if (policy.schemaVersion !== 1) throw new Error(`unsupported policy schema ${policy.schemaVersion}`);
	const records = new Map();
	for (const record of policy.records) {
		const id = String(record.advisory);
		if (records.has(id)) throw new Error(`duplicate policy advisory ${id}`);
		records.set(id, record);
	}
	const findings = Object.values(audit.advisories ?? {}).filter(({ severity }) =>
		severity === "high" || severity === "critical"
	);
	const findingsById = new Map(findings.map((finding) => [String(finding.id), finding]));

	for (const id of records.keys()) {
		if (!findingsById.has(id)) throw new Error(`stale policy advisory ${id}`);
	}
	for (const finding of findings) {
		const record = records.get(String(finding.id));
		if (!record) throw new Error(`unclassified ${finding.severity} advisory ${finding.id}`);
		if (record.status !== "upstream-blocked" || record.scope !== "consumer-runtime") {
			throw new Error(`unremediated ${finding.severity} advisory ${finding.id}`);
		}
		if (!record.owner?.trim()) throw new Error(`missing owner for advisory ${finding.id}`);
		if (record.package !== finding.module_name) {
			throw new Error(`package mismatch for advisory ${finding.id}`);
		}
		if (record.fixedVersion !== finding.patched_versions) {
			throw new Error(`fixed version mismatch for advisory ${finding.id}`);
		}
		const paths = [...new Set(finding.findings?.flatMap(({ paths: findingPaths }) => findingPaths) ?? [])];
		if (paths.length === 0 || paths.some((path) => !path.startsWith(".>@earendil-works/pi-"))) {
			throw new Error(`non-consumer path for advisory ${finding.id}`);
		}
		const policyPaths = Array.isArray(record.paths) ? [...new Set(record.paths)] : [];
		if (policyPaths.length !== record.paths?.length || policyPaths.length !== paths.length || policyPaths.some((path) => !paths.includes(path))) {
			throw new Error(`dependency chain mismatch for advisory ${finding.id}`);
		}
		if (policyPaths.some((path) => !path.includes(`>${record.upstream}>`))) {
			throw new Error(`upstream mismatch for advisory ${finding.id}`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(record.expires) || Number.isNaN(Date.parse(`${record.expires}T00:00:00Z`))) {
			throw new Error(`invalid expiry for advisory ${finding.id}`);
		}
		if (Date.parse(`${record.expires}T00:00:00Z`) <= Date.now()) throw new Error(`expired policy advisory ${finding.id}`);
	}

	console.log(
		`dependency audit policy passed; consumer-runtime upstream-blocked: ${findings.length}; local-development high/critical: 0`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
