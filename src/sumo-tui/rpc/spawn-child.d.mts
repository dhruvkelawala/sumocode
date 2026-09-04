export interface ChildSpawnPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export function buildChildSpawnPlan(
	env: NodeJS.ProcessEnv,
	argv: readonly string[],
	defaultPiBin?: string,
): ChildSpawnPlan | undefined;
