#!/usr/bin/env node
import { readFileSync } from "node:fs";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
	return process.argv[index + 1];
}

try {
	const audit = JSON.parse(readFileSync(argument("--audit"), "utf8"));
	const policy = JSON.parse(readFileSync(argument("--policy"), "utf8"));
	const records = new Map(
		policy.records.flatMap((record) => record.advisories.map((id) => [String(id), record])),
	);
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
		if (record.status !== "upstream-blocked") {
			throw new Error(`unremediated ${finding.severity} advisory ${finding.id}`);
		}
		if (Date.parse(`${record.expires}T00:00:00Z`) <= Date.now()) {
			throw new Error(`expired policy advisory ${finding.id}`);
		}
	}

	console.log(`dependency audit policy passed; consumer-runtime upstream-blocked: ${findings.length}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
