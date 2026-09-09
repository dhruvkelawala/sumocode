export const recoveryRepo: string;
export function recoveryEnvironment(root: string): NodeJS.ProcessEnv;
export function preflightRecovery(root: string): Promise<{ node: string; pi: string; provider: string; env: NodeJS.ProcessEnv }>;
