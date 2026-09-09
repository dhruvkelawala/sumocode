/**
 * Plan 117 Step 1: the launcher contract the native entry must reproduce,
 * expressed as tables shared by the bash-launcher suite
 * (`launcher-runtime-selection.test.ts`) and the native-binary suite.
 *
 * The contract is pinned from `bin/sumocode.sh`'s runtime selection (the
 * USE_RPC_HOST decision) and its subcommand handling — NOT from its bash
 * implementation details. Both launchers must honor: interactive TTY → RPC
 * host; `--print`/`-p`/`--mode`/non-TTY stdout/`--no-sumo-tui` → direct Pi;
 * `-h`/`-v`/`doctor`/`diag` subcommands; usage errors exit 64.
 */

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
export type LauncherCommandExpectation = "exit-0" | "doctor-runs" | "usage-error";

export interface LauncherCommandCase {
	readonly name: string;
	readonly argv: readonly string[];
	readonly expect: LauncherCommandExpectation;
	/** Substring the invocation's stdout must contain. */
	readonly stdoutContains?: string;
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
];

/** One parsed `--dry-run` output document. */
export interface DryRunObservation {
	readonly output: string;
	readonly exitCode: number;
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
