import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
	writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function writeFile(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

export function ensureDir(path) {
	mkdirSync(path, { recursive: true });
}

export function resetDir(path) {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
}

export function assertExists(path, label = path) {
	if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
}

export function slug(value) {
	return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
