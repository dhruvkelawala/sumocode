/**
 * Plan 117 Step 1: the launcher contract the native entry must reproduce,
 * expressed as tables shared by the bash-launcher suite
 * (`launcher-runtime-selection.test.ts`) and the native-binary suite.
 *
 * The contract is pinned from `bin/sumocode.sh`'s runtime selection (the
 * USE_RPC_HOST decision) and its subcommand handling — NOT from its bash
 * implementation details. Both launchers must honor: interactive TTY → RPC
 * host; `--print`/`-p`/`--mode`/non-TTY stdout/`--no-sumo-tui` → direct Pi;
 * `-h`/`-v`/`doctor`/`diag` subcommands; the `worktree`/`-w` command exits
 * with the worktree module's code; usage errors exit 64.
 */

import { LAUNCHER_COMMANDS, LAUNCHER_OPTIONS, type LauncherCommandSpec, type LauncherOptionSpec } from "../../src/cli/launcher-spec.js";

export type RuntimeBranch = "rpc-host" | "direct-pi";

export interface RuntimeSelectionCase {
	readonly name: string;
	readonly argv: readonly string[];
	/** Whether the launcher's stdout is an interactive TTY. */
	readonly stdoutTty: boolean;
	/** Which launcher branch must run. */
	readonly branch: RuntimeBranch;
}

export const RUNTIME_SELECTION_CASES: readonly RuntimeSelectionCase[] = [
	{
		name: "interactive TTY defaults to the RPC host",
		argv: [],
		stdoutTty: true,
		branch: "rpc-host",
	},
	{
		name: "interactive TTY forwards Pi flags to the RPC host",
		argv: ["--offline", "--no-extensions", "--no-session"],
		stdoutTty: true,
		branch: "rpc-host",
	},
	{
		name: "interactive TTY with a kickoff prompt stays on the RPC host",
		argv: ["--offline", "review the diff"],
		stdoutTty: true,
		branch: "rpc-host",
	},
	{
		name: "--print bypasses to direct Pi even on a TTY",
		argv: ["--print", "hello"],
		stdoutTty: true,
		branch: "direct-pi",
	},
	{
		name: "-p bypasses to direct Pi even on a TTY",
		argv: ["-p", "hello"],
		stdoutTty: true,
		branch: "direct-pi",
	},
	{
		name: "--mode bypasses to direct Pi even on a TTY",
		argv: ["--mode", "rpc", "--offline"],
		stdoutTty: true,
		branch: "direct-pi",
	},
	{
		name: "--no-sumo-tui bypasses to direct Pi",
		argv: ["--no-sumo-tui", "--offline"],
		stdoutTty: true,
		branch: "direct-pi",
	},
	{
		name: "non-TTY stdout bypasses to direct Pi",
		argv: [],
		stdoutTty: false,
		branch: "direct-pi",
	},
	{
		name: "post-delimiter --print is a message and stays on the RPC host",
		argv: ["--", "--print"],
		stdoutTty: true,
		branch: "rpc-host",
	},
];

/**
 * Simple subcommand/flag cases every launcher must honor. `{diagFile}` in
 * argv is replaced by each suite with its own temp diagnostics file path.
 * `doctor-runs` means the checks executed (exit 0 when healthy, 70 when
 * problems were found — both acceptable; anything else is a contract
 * failure).
 */
export type LauncherCommandExpectation = "exit-0" | "doctor-runs" | "usage-error" | "worktree-host-error";

export interface LauncherCommandCase {
	readonly name: string;
	readonly argv: readonly string[];
	readonly expect: LauncherCommandExpectation;
	/** Substring the invocation's stdout must contain. */
	readonly stdoutContains?: string;
	/** Substring the invocation's stdout must NOT contain. */
	readonly stdoutAbsent?: string;
	/** Substring the invocation's stderr must contain. */
	readonly stderrContains?: string;
}

/** Dry-run fields a `--dry-run` case asserts (`ARGS` etc. come from `dryRunField`). */
export interface LauncherDryRunExpectation {
	readonly command?: string;
	readonly args?: string;
	readonly debug?: string;
	readonly diagFile?: string;
}

export const LAUNCHER_COMMAND_CASES: readonly LauncherCommandCase[] = [
	{ name: "-h prints usage and exits 0", argv: ["-h"], expect: "exit-0", stdoutContains: "USAGE" },
	{ name: "--help prints usage and exits 0", argv: ["--help"], expect: "exit-0", stdoutContains: "USAGE" },
	{ name: "-v prints the version banner", argv: ["-v"], expect: "exit-0", stdoutContains: "sumocode " },
	{ name: "--version prints the version banner", argv: ["--version"], expect: "exit-0", stdoutContains: "sumocode " },
	{ name: "doctor runs its checks", argv: ["doctor"], expect: "doctor-runs", stdoutContains: "SumoCode doctor" },
	{ name: "diag summarizes a diagnostics file", argv: ["diag", "{diagFile}"], expect: "exit-0", stdoutContains: "Event counts" },
	{ name: "doctor rejects a path argument", argv: ["doctor", "somepath"], expect: "usage-error" },
	{ name: "diag rejects more than one path", argv: ["diag", "a.jsonl", "b.jsonl"], expect: "usage-error" },
	{ name: "worktree without a terminal host reports the host requirement", argv: ["worktree"], expect: "worktree-host-error", stderrContains: "requires a running herdr terminal host" },
	{ name: "-w without a terminal host reports the host requirement", argv: ["-w"], expect: "worktree-host-error", stderrContains: "requires a running herdr terminal host" },
	{ name: "worktree rejects more than one worktree name", argv: ["worktree", "a", "b"], expect: "usage-error" },
	{ name: "-w rejects more than one worktree name", argv: ["-w", "a", "b"], expect: "usage-error" },
	{ name: "worktree rejects a task-only --prompt-file", argv: ["--dry-run", "worktree", "--prompt-file", "/tmp/nope"], expect: "usage-error", stderrContains: "[sumocode] --prompt-file is only valid with the 'task' subcommand." },
	{ name: "worktree rejects a task-only --task-dir", argv: ["--dry-run", "worktree", "--task-dir", "/tmp/nope"], expect: "usage-error", stderrContains: "[sumocode] --task-dir is only valid with the 'task' subcommand." },
	{ name: "worktree dry run prints the resolved name", argv: ["--dry-run", "worktree", "dry-wt"], expect: "exit-0", stdoutContains: "worktree dry run" },
	{ name: "-w dry run prints the resolved name", argv: ["--dry-run", "-w", "dry-wt"], expect: "exit-0", stdoutContains: "worktree dry run" },
];

/** One parsed `--dry-run` output document. */
export interface DryRunObservation {
	readonly output: string;
	readonly exitCode: number;
}

/** Result shape both suites produce before the shared assertions run. */
export interface LauncherCaseResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Per-case files `{diagFile}` / `{promptFile}` / `{taskDir}` expand to. */
export interface LauncherCasePaths {
	readonly diagFile: string;
	readonly promptFile: string;
	readonly taskDir: string;
}

export function expandLauncherArgv(argv: readonly string[], paths: LauncherCasePaths): string[] {
	return argv.map((arg) => {
		if (arg === "{diagFile}") return paths.diagFile;
		if (arg === "{promptFile}") return paths.promptFile;
		if (arg === "{taskDir}") return paths.taskDir;
		return arg;
	});
}

/**
 * Shared assertions for one launcher invocation. Returns one line per failed
 * expectation (empty when the case passed) so both suites report identically.
 */
export function launcherCaseFailures(result: LauncherCaseResult, row: LauncherCommandCase & { readonly dryRun?: LauncherDryRunExpectation }): readonly string[] {
	const failures: string[] = [];
	const accepted = row.expect === "exit-0" ? [0]
		: row.expect === "doctor-runs" ? [0, 70]
		: row.expect === "worktree-host-error" ? [1]
		: [64];
	if (!accepted.includes(result.status)) failures.push(`exit ${result.status} not in ${accepted.join("/")}`);
	if (row.stdoutContains !== undefined && !result.stdout.includes(row.stdoutContains)) failures.push(`stdout missing ${JSON.stringify(row.stdoutContains)}`);
	if (row.stdoutAbsent !== undefined && result.stdout.includes(row.stdoutAbsent)) failures.push(`stdout still contains ${JSON.stringify(row.stdoutAbsent)}`);
	if (row.stderrContains !== undefined && !result.stderr.includes(row.stderrContains)) failures.push(`stderr missing ${JSON.stringify(row.stderrContains)}`);
	if (row.dryRun !== undefined) {
		const fields: readonly (readonly [string, string | undefined])[] = [
			["COMMAND", row.dryRun.command],
			["ARGS", row.dryRun.args],
			["SUMO_TUI_DEBUG", row.dryRun.debug],
			["SUMO_TUI_DIAG_FILE", row.dryRun.diagFile],
		];
		for (const [field, expected] of fields) {
			if (expected === undefined) continue;
			const observed = dryRunField(result.stdout, field);
			if (observed !== expected) failures.push(`${field}=${JSON.stringify(observed)} expected ${JSON.stringify(expected)}`);
		}
	}
	return failures;
}

/** Extracts a `FIELD=value` line from dry-run output ("" when absent). */
export function dryRunField(output: string, field: string): string {
	const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(`${field}=`));
	return line === undefined ? "" : line.slice(field.length + 1);
}

/** The `exec …` line from dry-run output (throws when missing). */
export function dryRunExecLine(output: string): string {
	const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("exec "));
	if (line === undefined) throw new Error(`dry-run output missing exec line. Output:\n${output}`);
	return line;
}

/**
 * Branch detection shared by both suites: RPC when the exec line launches
 * the RPC host runner, direct Pi otherwise. Deliberately implementation-
 * shaped markers stay in the per-suite assertions; this only classifies.
 */
export function classifyBranch(execLine: string): RuntimeBranch {
	return execLine.includes("sumo-rpc-host.js") ? "rpc-host" : "direct-pi";
}

// ── spec-derived parity matrix (issue 484) ─────────────────────────────────

/** A `--dry-run` parity case: every spec spelling, run through both parsers. */
export interface LauncherParityCase extends LauncherCommandCase {
	readonly dryRun?: LauncherDryRunExpectation;
}

/** Deterministic argv per command spelling; both suites prepend `--dry-run`. */
function commandParityCase(spec: LauncherCommandSpec, spelling: string): LauncherParityCase {
	const name = `shares the ${spelling} command spelling`;
	switch (spec.command) {
		case "run":
			return { name, argv: [spelling], expect: "exit-0", dryRun: { command: "run", args: "" } };
		case "doctor":
			return { name, argv: [spelling], expect: "doctor-runs", stdoutContains: "SumoCode doctor" };
		case "diag":
			return { name, argv: [spelling, "{diagFile}"], expect: "exit-0", stdoutContains: "Event counts" };
		case "task":
			return { name, argv: [spelling, "parity task prompt"], expect: "exit-0", dryRun: { command: "task" } };
		case "worktree":
			return { name, argv: [spelling, "parity-worktree"], expect: "exit-0", stdoutContains: "worktree dry run" };
	}
}

/** `run <command>`: an explicit run keeps the later spelling positional (issue 484). */
function explicitRunPositionalCase(spec: LauncherCommandSpec): LauncherParityCase {
	return {
		name: `explicit run keeps ${spec.command} positional`,
		argv: ["run", spec.command],
		expect: "exit-0",
		dryRun: { command: "run", args: "[redacted]" },
	};
}

function optionParityCase(spec: LauncherOptionSpec, flag: string): LauncherParityCase {
	const name = `shares the ${flag} option spelling`;
	switch (spec.id) {
		case "help":
			return { name, argv: [flag], expect: "exit-0", stdoutContains: "USAGE" };
		case "version":
			return { name, argv: [flag], expect: "exit-0", stdoutContains: "sumocode " };
		case "debug":
			return { name, argv: [flag], expect: "exit-0", dryRun: { debug: "1" } };
		case "diag-file":
			return { name, argv: [flag, "{diagFile}"], expect: "exit-0", dryRun: { debug: "1" } };
		case "no-clear-diag":
			return { name, argv: ["-d", flag], expect: "exit-0", dryRun: { debug: "1" } };
		case "prompt-file":
			return { name, argv: ["task", flag, "{promptFile}"], expect: "exit-0", dryRun: { command: "task" } };
		case "task-dir":
			return { name, argv: ["task", flag, "{taskDir}"], expect: "exit-0", dryRun: { command: "task" } };
		case "no-sumo-tui":
			return { name, argv: [flag], expect: "exit-0" };
		case "dry-run":
			return { name, argv: [flag], expect: "exit-0" };
	}
}

/**
 * Every command, alias and option spelling the shared spec declares, run
 * through BOTH launchers. Generated from the spec so adding a command (or a
 * `-w`-style alias, #483) without implementing it in both parsers fails CI in
 * both suites at once.
 */
export const LAUNCHER_PARITY_CASES: readonly LauncherParityCase[] = [
	...LAUNCHER_COMMANDS.flatMap((spec) => [spec.command, ...spec.aliases].map((spelling) => commandParityCase(spec, spelling))),
	...LAUNCHER_OPTIONS.flatMap((spec) => spec.flags.map((flag) => optionParityCase(spec, flag))),
	// Explicit `run` owns the launch: a later known-command spelling is a
	// path/prompt positional, not a command switch, so `run doctor` dispatches
	// `run` in both launchers. Positional bytes are redacted in dry-run output.
	...LAUNCHER_COMMANDS.filter((spec) => spec.command !== "run").map(explicitRunPositionalCase),
	// Repeating the same command through its spellings is idempotent in both
	// launchers (issue 484): canonical+alias and alias+alias must launch the
	// worktree command instead of exiting 64.
	{
		name: "repeats the worktree command with its alias",
		argv: ["worktree", "-w"],
		expect: "exit-0",
		stdoutContains: "worktree dry run",
	},
	{
		name: "repeats the worktree alias with another alias",
		argv: ["-w", "--worktree"],
		expect: "exit-0",
		stdoutContains: "worktree dry run",
	},
	// Rejection rows (issue 484): when a launcher-owned check rejects a token it
	// must name the offending token on stderr, exit 64, and never reach Pi.
	// Unknown options in Pi-forwarding contexts (run/task) deliberately stay
	// Pi's business: the launcher mirrors Pi's generic extension-flag and
	// unknown-short classes, pinned by
	// test/integration/spawn-pi-pty.test.ts's option-consumption fixtures.
	{
		name: "rejects a second command with the offending token",
		argv: ["doctor", "diag"],
		expect: "usage-error",
		stderrContains: "diag",
		stdoutAbsent: "exec ",
	},
	{
		name: "rejects a doctor argument with the offending token",
		argv: ["doctor", "somepath"],
		expect: "usage-error",
		stderrContains: "somepath",
		stdoutAbsent: "exec ",
	},
	{
		name: "rejects a second diag path with the offending token",
		argv: ["diag", "a.jsonl", "b.jsonl"],
		expect: "usage-error",
		stderrContains: "b.jsonl",
	},
	{
		name: "rejects a second worktree name with the offending token",
		argv: ["-w", "a", "b"],
		expect: "usage-error",
		stderrContains: "b",
	},
	{
		name: "rejects a worktree alias after another command with the offending token",
		argv: ["doctor", "-w"],
		expect: "usage-error",
		stderrContains: "Only one command may be specified: -w",
	},
	{
		name: "usage errors point at --help",
		argv: ["doctor", "diag"],
		expect: "usage-error",
		stderrContains: "Run 'sumocode --help' for usage.",
	},
];

/** Every spelling the shared spec declares. */
export function launcherSpecSpellings(): readonly string[] {
	return [
		...LAUNCHER_COMMANDS.flatMap((spec) => [spec.command, ...spec.aliases]),
		...LAUNCHER_OPTIONS.flatMap((spec) => spec.flags),
	];
}

/** Spec spellings without a parity row; must stay empty. */
export function launcherParityGaps(): readonly string[] {
	const covered = new Set(LAUNCHER_PARITY_CASES.flatMap((row) => row.argv));
	return launcherSpecSpellings().filter((spelling) => !covered.has(spelling));
}
