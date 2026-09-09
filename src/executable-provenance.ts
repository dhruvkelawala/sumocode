import { resolve } from "node:path";

export interface ExecutableProvenance {
	readonly pi: string;
	readonly sumocode: string;
}

export interface ExecutableProvenanceOptions {
	readonly pi?: string;
	readonly sumocode?: string;
	readonly env?: NodeJS.ProcessEnv;
}

function resolveCommand(explicit: string | undefined, inherited: string | undefined, fallback: string): string {
	const configured = [explicit, inherited].map((value) => value?.trim()).find(Boolean) ?? fallback;
	return configured.includes("/") || configured.includes("\\") ? resolve(configured) : configured;
}

export function resolveExecutableProvenance(options: ExecutableProvenanceOptions = {}): ExecutableProvenance {
	const env = options.env ?? process.env;
	return Object.freeze({
		pi: resolveCommand(options.pi, env.PI_BIN, "pi"),
		sumocode: resolveCommand(options.sumocode, env.SUMOCODE_LAUNCHER, "sumocode"),
	});
}
