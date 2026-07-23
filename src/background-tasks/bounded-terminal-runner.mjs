#!/usr/bin/env node

import { spawn } from "node:child_process";
import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";

const [platform, commandFile, logFile, rawMaxBytes] = process.argv.slice(2);
const maxBytes = Number.parseInt(rawMaxBytes ?? "", 10);
if ((platform !== "posix" && platform !== "win32") || !commandFile || !logFile || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
	process.stderr.write("usage: bounded-terminal-runner <posix|win32> <command-file> <log-file> <max-bytes>\n");
	process.exit(125);
}

const descriptor = openSync(logFile, "r+");
let size = fstatSync(descriptor).size;

function appendBounded(value) {
	const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
	if (chunk.length === 0) return;
	if (size + chunk.length <= maxBytes) {
		writeSync(descriptor, chunk, 0, chunk.length, size);
		size += chunk.length;
		return;
	}

	const incoming = chunk.length >= maxBytes ? chunk.subarray(chunk.length - maxBytes) : chunk;
	const retainedBytes = Math.max(0, maxBytes - incoming.length);
	const retained = Buffer.alloc(Math.min(size, retainedBytes));
	if (retained.length > 0) readSync(descriptor, retained, 0, retained.length, size - retained.length);
	const next = retained.length > 0 ? Buffer.concat([retained, incoming], retained.length + incoming.length) : incoming;
	// This process is the sole writer for command output. Compaction therefore
	// cannot race a shell redirection append and never discards a newer chunk.
	ftruncateSync(descriptor, 0);
	writeSync(descriptor, next, 0, next.length, 0);
	size = next.length;
}

const child = platform === "win32"
	? spawn("cmd.exe", ["/d", "/s", "/c", commandFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
	: spawn("/bin/bash", [commandFile], { stdio: ["ignore", "pipe", "pipe"] });

child.stdout?.on("data", appendBounded);
child.stderr?.on("data", appendBounded);
child.on("error", (error) => appendBounded(Buffer.from(`[spawn error] ${error.message}\n`, "utf8")));
child.on("close", (code) => {
	closeSync(descriptor);
	process.exitCode = typeof code === "number" ? code : 1;
});
