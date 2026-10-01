import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	state?: string;
	start?: string;
	command: string;
}

interface RegisteredSurvivor {
	path: string;
	pid: number;
	pgid: number;
	start: string;
	command: string;
}

interface PreflightIssue {
	code: string;
	message: string;
	remediation: string;
	path?: string;
	paths?: string[];
	rows?: ProcessRow[];
	registeredSurvivors?: RegisteredSurvivor[];
}

interface ProcessTable {
	rows: ProcessRow[];
	issue?: PreflightIssue;
}

interface PreflightReport {
	issues: PreflightIssue[];
	notices: string[];
	retainedEvidence: string[];
	liveHarnessPids: number[];
}

type ExecuteText = (command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string;
type SignalProcess = (pid: number, signal: NodeJS.Signals | number) => boolean | void;

interface InspectOptions {
	root?: string;
	tempRoot?: string;
	rows?: ProcessRow[] | ProcessTable;
	env?: NodeJS.ProcessEnv;
}

// The reaper validates these untrusted identity fields before authorizing signals.
interface GroupRegistration {
	readonly pid?: unknown;
	readonly pgid?: unknown;
	readonly processStart?: unknown;
	readonly ownerPid?: unknown;
	readonly ownerProcessStart?: unknown;
	readonly ownerToken?: unknown;
	readonly ownershipMode?: unknown;
	readonly runId?: unknown;
	readonly registrationHmac?: unknown;
	readonly signingKey?: unknown;
}

interface ReapOptions {
	readProcessTable?: () => unknown;
	currentPgid?: number;
	readProcessStart?: (pid: number) => string | undefined;
	kill?: SignalProcess;
	wait?: () => Promise<unknown>;
}

type ReapResult =
	| { status: "exited" | "reaped" | "survived"; identityStatus?: never; error?: never }
	| { status: "unverified"; identityStatus: "unknown" | "different"; error: string };

interface FixOptions {
	purgeEvidence?: boolean;
	table?: ProcessTable;
	rows?: ProcessRow[];
	readRows?: () => ProcessRow[];
	currentPgid?: number;
	kill?: SignalProcess;
	wait?: () => Promise<unknown>;
}

interface FixReport {
	issues: PreflightIssue[];
	retainedEvidence?: string[];
	liveHarnessPids?: number[];
}

interface FixRefusal {
	refused: true;
	reason: string;
	issues?: PreflightIssue[];
}

export function processRows(execute?: ExecuteText): {
	rows: (ProcessRow & { state: string; start: string })[];
	issue?: PreflightIssue;
};
export function liveProcessStart(pid: number, execute?: ExecuteText): string | undefined;
export function inspectIntegrationPreflight(options?: InspectOptions): Promise<PreflightReport>;
export function reapHarnessProcessGroup(registration: GroupRegistration, options?: ReapOptions): Promise<ReapResult>;
export function fixIntegrationPreflight(report: FixReport, options?: FixOptions): Promise<FixRefusal | undefined>;
export function runIntegrationPreflight(options?: { fix?: boolean; purgeEvidence?: boolean }): Promise<boolean>;
