import { performance } from "node:perf_hooks";
import { logDiagnostic } from "./diagnostics.js";

export const RESUME_BUDGET_MS = 500;

export type ResumeStageName =
	| "session_scan"
	| "transcript_model"
	| "transcript_hydrate"
	| "yoga_first_layout"
	| "first_frame_render";

export interface ResumeStageTiming {
	readonly name: ResumeStageName;
	readonly durationMs: number;
}

export interface ResumeProfileMetadata {
	readonly sourceMessages?: number;
	readonly acceptedMessages?: number;
	readonly renderedMessages?: number;
	readonly archivedMessages?: number;
}

export interface ResumeProfile {
	readonly totalMs: number;
	readonly budgetMs: number;
	readonly pass: boolean;
	readonly stages: readonly ResumeStageTiming[];
	readonly metadata: ResumeProfileMetadata;
}

export interface ResumeProfileSummary {
	readonly total: PercentileSummary;
	readonly stages: Record<ResumeStageName, PercentileSummary>;
}

export interface PercentileSummary {
	readonly p50Ms: number;
	readonly p95Ms: number;
}

export type ResumeClock = () => number;

function defaultClock(): number {
	return performance.now();
}

function roundMs(value: number): number {
	return Math.round(value * 100) / 100;
}

function formatMs(value: number): string {
	return `${value.toFixed(value >= 100 ? 0 : 2)}ms`;
}

function percentile(values: readonly number[], percentileValue: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

function summarize(values: readonly number[]): PercentileSummary {
	return {
		p50Ms: roundMs(percentile(values, 50)),
		p95Ms: roundMs(percentile(values, 95)),
	};
}

export class ResumeProfiler {
	private readonly startedAt: number;
	private readonly stageTimings: ResumeStageTiming[] = [];

	public constructor(private readonly clock: ResumeClock = defaultClock) {
		this.startedAt = this.clock();
	}

	public measure<T>(name: ResumeStageName, run: () => T): T {
		const startedAt = this.clock();
		try {
			return run();
		} finally {
			this.stageTimings.push({ name, durationMs: roundMs(this.clock() - startedAt) });
		}
	}

	public finish(metadata: ResumeProfileMetadata = {}): ResumeProfile {
		const totalMs = roundMs(this.clock() - this.startedAt);
		return {
			totalMs,
			budgetMs: RESUME_BUDGET_MS,
			pass: totalMs <= RESUME_BUDGET_MS,
			stages: [...this.stageTimings],
			metadata,
		};
	}
}

export function summarizeResumeProfiles(profiles: readonly ResumeProfile[]): ResumeProfileSummary {
	const stageNames: readonly ResumeStageName[] = ["session_scan", "transcript_model", "transcript_hydrate", "yoga_first_layout", "first_frame_render"];
	const stages = Object.fromEntries(stageNames.map((name) => {
		const values = profiles.flatMap((profile) => profile.stages.filter((stage) => stage.name === name).map((stage) => stage.durationMs));
		return [name, summarize(values)];
	})) as Record<ResumeStageName, PercentileSummary>;
	return {
		total: summarize(profiles.map((profile) => profile.totalMs)),
		stages,
	};
}

export function formatResumeBudgetOverlay(profile: ResumeProfile): string {
	const status = profile.pass ? "PASS" : "MISS";
	const stages = profile.stages.map((stage) => `${stage.name}=${formatMs(stage.durationMs)}`).join(" ");
	const messages = profile.metadata.sourceMessages === undefined
		? ""
		: ` messages=${profile.metadata.sourceMessages} rendered=${profile.metadata.renderedMessages ?? "?"} archived=${profile.metadata.archivedMessages ?? "?"}`;
	return `resume-budget overlay: total=${formatMs(profile.totalMs)} budget=${formatMs(profile.budgetMs)} ${status}${messages} | ${stages}`;
}

export function emitResumeBudgetOverlay(profile: ResumeProfile): void {
	const stageFields = Object.fromEntries(profile.stages.map((stage) => [`${stage.name}_ms`, stage.durationMs]));
	logDiagnostic("resume_budget", {
		total_ms: profile.totalMs,
		budget_ms: profile.budgetMs,
		pass: profile.pass,
		source_messages: profile.metadata.sourceMessages,
		accepted_messages: profile.metadata.acceptedMessages,
		rendered_messages: profile.metadata.renderedMessages,
		archived_messages: profile.metadata.archivedMessages,
		...stageFields,
	});
	if (process.env.SUMO_TUI_DEBUG === "1") {
		console.error(`[sumo-tui] ${formatResumeBudgetOverlay(profile)}`);
	}
}
