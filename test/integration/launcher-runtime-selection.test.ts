/**
 * Plan 117 Step 1: pins the launcher runtime-selection contract from the
 * shared table in `launcher-runtime-contract.ts` against `bin/sumocode.sh`
 * behavior. The native entry suite consumes the same tables so a contract
 * change forces both launchers to move together.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node-pty";
import { afterAll, describe, expect, it } from "vitest";
import { renderLauncherHelp } from "../../src/cli/launcher-spec.js";
import {
	classifyBranch,
	dryRunExecLine,
	dryRunField,
	expandLauncherArgv,
	launcherCaseFailures,
	launcherParityGaps,
	LAUNCHER_COMMAND_CASES,
	LAUNCHER_PARITY_CASES,
	RUNTIME_SELECTION_CASES,
	type DryRunObservation,
	type LauncherCasePaths,
} from "./launcher-runtime-contract.js";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

const LAUNCHER = resolve(process.env.SUMOCODE_INTEGRATION_PACKAGE_ROOT ?? process.cwd(), "bin/sumocode.sh");
// The launcher resolves ROOT_DIR from its own location (bin/..), matching
// launcher-prompt-transport.test.ts's derivation.
const EXTENSION_ENTRY = resolve(dirname(LAUNCHER), "..", "src/extension-entry.ts");
const STUB_PI = "/bin/echo";

function ensureNodePtySpawnHelperExecutable(): void {
	try {
		const require = createRequire(import.meta.url);
		const nodePtyMain = require.resolve("node-pty");
		const spawnHelper = join(dirname(nodePtyMain), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
		if (!require("node:fs").existsSync(spawnHelper)) return;
		require("node:fs").chmodSync(spawnHelper, 0o755);
	} catch {
		// Resolution differences surface as a real spawn error below.
	}
}

/** Runs `bin/sumocode.sh --dry-run <args>` with stdout on a real PTY. */
function ptyDryRun(args: readonly string[]): Promise<DryRunObservation> {
	ensureNodePtySpawnHelperExecutable();
	return new Promise<DryRunObservation>((resolveRun) => {
		const launcherArgs = ["--dry-run", ...args];
		const childEnv = buildSpawnEnv(process.env, { PI_BIN: STUB_PI });
		const child = spawn(LAUNCHER, launcherArgs, {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd: process.cwd(),
			env: childEnv,
		});
		let output = "";
		child.onData((data) => {
			output += data;
		});
		child.onExit(({ exitCode }) => {
			resolveRun({ output, exitCode });
		});
	});
}

function pipeDryRun(args: readonly string[]): DryRunObservation {
	const output = execFileSync("bash", [LAUNCHER, "--dry-run", ...args], {
		cwd: process.cwd(),
		env: buildSpawnEnv(process.env, { PI_BIN: STUB_PI }),
		encoding: "utf8",
		input: "",
	});
	return { output, exitCode: 0 };
}

async function dryRun(args: readonly string[], stdoutTty: boolean): Promise<DryRunObservation> {
	return stdoutTty ? ptyDryRun(args) : Promise.resolve(pipeDryRun(args));
}

describe("launcher runtime selection (plan 117 shared contract)", () => {
	for (const row of RUNTIME_SELECTION_CASES) {
		it(row.name, async () => {
			const { output } = await dryRun(row.argv, row.stdoutTty);
			const execLine = dryRunExecLine(output);
			expect(classifyBranch(execLine)).toBe(row.branch);
			if (row.branch === "rpc-host") {
				expect(dryRunField(output, "SUMO_RPC")).toBe("1");
				expect(dryRunField(output, "SUMO_TUI")).toBe("0");
				expect(execLine).toContain("/sumo-rpc-host.js");
			} else {
				expect(dryRunField(output, "SUMO_RPC")).toBe("");
				expect(dryRunField(output, "SUMO_TUI")).toBe("0");
				expect(execLine).toContain(`-e ${EXTENSION_ENTRY}`);
				expect(execLine).not.toContain("sumo-rpc-host.js");
			}
		});
	}

	it("honors an inherited SUMO_TUI_DIAG_FILE for debug defaults", () => {
		const { output } = pipeDryRun([]);
		expect(dryRunField(output, "SUMO_TUI_DEBUG")).toBe("");
		expect(dryRunField(output, "SUMO_TUI_DIAG_FILE")).toBe("");
	});

	it("-d enables debug diagnostics in dry-run output", () => {
		const { output } = pipeDryRun(["-d"]);
		expect(dryRunField(output, "SUMO_TUI_DEBUG")).toBe("1");
		expect(dryRunField(output, "SUMO_TUI_DIAG_FILE")).toBe("/tmp/sumocode-manual.jsonl");
	});

	it("--diag-file wins over the debug default and implies -d", () => {
		const { output } = pipeDryRun(["--diag-file", "/tmp/plan117-diag.jsonl"]);
		expect(dryRunField(output, "SUMO_TUI_DEBUG")).toBe("1");
		expect(dryRunField(output, "SUMO_TUI_DIAG_FILE")).toBe("/tmp/plan117-diag.jsonl");
	});

	it("--no-clear-diag keeps the diagnostics file flag isolated from clearing", () => {
		const { output } = pipeDryRun(["-d", "--no-clear-diag"]);
		expect(dryRunField(output, "SUMO_TUI_DEBUG")).toBe("1");
	});
});

interface CommandResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

function runCommand(args: readonly string[], env: NodeJS.ProcessEnv = {}): CommandResult {
	try {
		const stdout = execFileSync("bash", [LAUNCHER, ...args], {
			cwd: process.cwd(),
			env: buildSpawnEnv(process.env, { PI_BIN: STUB_PI, ...env }),
			encoding: "utf8",
			input: "",
			timeout: 30_000,
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		// SAFETY: execFileSync augments thrown process errors with numeric status
		// and captured stdout/stderr when encoding is utf8.
		const err = error as Partial<CommandResult>;
		return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

describe("launcher help (plan 117 shared contract)", () => {
	it("renders the shared CLI spec help verbatim", () => {
		const result = runCommand(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(renderLauncherHelp());
	});

	it("renders -h identically to --help", () => {
		expect(runCommand(["-h"]).stdout).toBe(runCommand(["--help"]).stdout);
	});

	it("fails with a stderr diagnostic when node cannot render the shared spec", () => {
		// A shim `node` that exits non-zero stands in for a Node without type
		// stripping (or a layout where the spec import fails): the launcher must
		// not report empty success when help rendered nothing. The shim also
		// echoes its argv so the strip-types flag path stays pinned for Node
		// versions that need it explicitly (22.6-22.17).
		const shimDir = mkdtempSync(join(tmpdir(), "sumocode-help-node-failure-"));
		writeFileSync(
			join(shimDir, "node"),
			"#!/bin/sh\nprintf 'simulated node failure\\n' >&2\nprintf 'node argv: %s\\n' \"$*\" >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		try {
			const result = runCommand(["--help"], { PATH: `${shimDir}:${process.env.PATH ?? ""}` });
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Could not render help");
			expect(result.stderr).toContain("TypeScript type stripping");
			expect(result.stderr).toContain("src/cli/launcher-spec.ts");
			expect(result.stderr).toContain("--experimental-strip-types");
		} finally {
			rmSync(shimDir, { recursive: true, force: true });
		}
	});
});

describe("launcher parity matrix (issue 484 shared spec)", () => {
	const root = mkdtempSync(join(tmpdir(), "sumocode-parity-shell-"));
	const paths: LauncherCasePaths = {
		diagFile: join(root, "diag.jsonl"),
		promptFile: join(root, "prompt.txt"),
		taskDir: join(root, "task"),
	};
	mkdirSync(paths.taskDir, { recursive: true });
	writeFileSync(paths.diagFile, `${JSON.stringify({ event: "boot_screen_frame" })}\n`);
	writeFileSync(paths.promptFile, "parity task prompt\n");
	writeFileSync(join(paths.taskDir, "prompt.txt"), "parity task prompt\n");

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	for (const row of LAUNCHER_PARITY_CASES) {
		it(row.name, () => {
			const result = runCommand(["--dry-run", ...expandLauncherArgv(row.argv, paths)]);
			expect(launcherCaseFailures(result, row).join("\n")).toBe("");
		});
	}

	it("covers every command, alias, and option in the shared spec", () => {
		expect(launcherParityGaps()).toEqual([]);
	});
});

describe("launcher subcommands (plan 117 shared contract)", () => {
	const diagDir = mkdtempSync(join(tmpdir(), "sumocode-runtime-contract-diag-"));
	const diagFile = join(diagDir, "diag.jsonl");

	afterAll(() => {
		rmSync(diagDir, { recursive: true, force: true });
	});

	writeFileSync(diagFile, `${JSON.stringify({ event: "boot_screen_frame" })}\n`);

	for (const row of LAUNCHER_COMMAND_CASES) {
		it(row.name, () => {
			const argv = row.argv.map((arg) => (arg === "{diagFile}" ? diagFile : arg));
			const result = runCommand(argv);
			if (row.expect === "exit-0") {
				expect(result.status).toBe(0);
			} else if (row.expect === "doctor-runs") {
				expect([0, 70]).toContain(result.status);
			} else if (row.expect === "worktree-host-error") {
				expect(result.status).toBe(1);
			} else {
				expect(result.status).toBe(64);
			}
			if (row.stdoutContains !== undefined) {
				expect(result.stdout).toContain(row.stdoutContains);
			}
			if (row.stderrContains !== undefined) {
				expect(result.stderr).toContain(row.stderrContains);
			}
		});
	}
});
