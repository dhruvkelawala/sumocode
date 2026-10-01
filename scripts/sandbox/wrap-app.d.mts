import type { ExecFileSyncOptionsWithStringEncoding, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
export function createTestAgentDir(tempDir: string, cwd: string): string;
export function wrapTestApp(command: string, args: readonly string[], options?: {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	ports?: readonly number[];
}): { command: string; args: string[]; env: NodeJS.ProcessEnv };
export function spawnTestAppSync(command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function execTestAppSync(command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
