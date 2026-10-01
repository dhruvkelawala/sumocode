import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { type IPty, type IPtyForkOptions } from "node-pty";
import { HARNESS_OWNER_TOKEN_ENV_KEY, HARNESS_RUN_ID_ENV_KEY, HARNESS_SIGNATURE, HARNESS_SIGNATURE_ENV_KEY, HARNESS_SIGNING_KEY_ENV_KEY } from "../../scripts/lib/integration-harness-constants.mjs";
export { HARNESS_OWNER_TOKEN_ENV_KEY, HARNESS_RUN_ID_ENV_KEY, HARNESS_SIGNATURE, HARNESS_SIGNATURE_ENV_KEY, HARNESS_SIGNING_KEY_ENV_KEY, };
export type ReadinessState = "boot" | "input" | "app";
export declare const READINESS_EVENT_BY_STATE: {
    readonly boot: "boot_screen_frame";
    readonly input: "editor_ready";
    readonly app: "stable_chrome_ready";
};
export interface TimeoutEvidenceInput {
    readonly evidenceDir: string;
    readonly argv: readonly string[];
    readonly stderrPath: string;
    readonly diagPath: string;
    readonly output: string;
    readonly finalScreen: string;
}
export interface ChildEvidenceContext {
    readonly evidenceDir: string;
    readonly stderrPath: string;
    readonly diagPath: string;
    readonly argv: readonly string[];
}
interface DiagnosticReadinessEvent {
    readonly event: string;
}
export interface SupervisedProcess {
    readonly child: ChildProcess;
    readonly pid: number;
    readonly pgid: number;
    readonly evidence: ChildEvidenceContext;
    terminate(): Promise<void>;
    shouldCaptureExitFailure(hasPendingWaiters: boolean): boolean;
    captureFailure(output?: string, finalScreen?: string): Promise<string>;
}
export interface HarnessAuth {
    readonly runId: string;
    readonly signingKey: string;
}
/**
 * Resolve the signing identity before a child exists. Failing after spawn
 * would leave a detached process with no handle to reap it.
 */
export declare function requireHarnessAuth(env: NodeJS.ProcessEnv): HarnessAuth;
interface HarnessAuditFailure {
    readonly phase: string;
    readonly pid: number;
    readonly pgid: number;
    readonly processStart?: string;
    readonly reason: string;
}
export declare function recordHarnessAuditFailure(phase: string, pid: number, pgid: number, env: NodeJS.ProcessEnv, reason: string, processStart?: string | undefined): void;
export declare function harnessAuditFailures(root: string): HarnessAuditFailure[];
export declare function createChildEvidenceContext(argv: readonly string[], env?: NodeJS.ProcessEnv, diagPath?: string): ChildEvidenceContext;
export declare function captureTimeoutEvidence(input: TimeoutEvidenceInput): Promise<string>;
export declare function waitForDiagnosticReadiness(diagPath: string, state: ReadinessState, timeoutMs: number): Promise<DiagnosticReadinessEvent>;
export declare function spawnSupervisedProcess(command: string, args: readonly string[], options?: SpawnOptions): SupervisedProcess;
export declare function spawnSupervisedPty(command: string, args: readonly string[], options: IPtyForkOptions, evidence: ChildEvidenceContext, auth: HarnessAuth): {
    child: IPty;
    supervision: Pick<SupervisedProcess, "pid" | "pgid" | "evidence" | "terminate" | "captureFailure">;
};
/**
 * The PTY child already exists when this runs, so it takes the auth the
 * caller resolved with requireHarnessAuth BEFORE spawning.
 */
export declare function supervisePtyProcess(pid: number, evidence: ChildEvidenceContext, env: NodeJS.ProcessEnv, auth: HarnessAuth): Pick<SupervisedProcess, "pid" | "pgid" | "evidence" | "terminate" | "captureFailure">;
export declare function recordPtyExit(pid: number, pgid: number, exitCode: number, signal: number | undefined, env: NodeJS.ProcessEnv): void;
export function finalizeFocusedNamespace(): Promise<void>;
