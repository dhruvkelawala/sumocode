import { describe, expect, it } from "vitest";
import { formatResumeBudgetOverlay, ResumeProfiler, summarizeResumeProfiles } from "./resume-profiler.js";

describe("ResumeProfiler", () => {
	it("records stage timings and formats the debug budget overlay", () => {
		let now = 0;
		const profiler = new ResumeProfiler(() => now);

		profiler.measure("session_scan", () => {
			now += 5;
		});
		profiler.measure("transcript_hydrate", () => {
			now += 12;
		});
		now += 3;
		const profile = profiler.finish({ sourceMessages: 1000, renderedMessages: 200, archivedMessages: 800 });

		expect(profile.totalMs).toBe(20);
		expect(profile.pass).toBe(true);
		expect(formatResumeBudgetOverlay(profile)).toContain("resume-budget overlay: total=20.00ms budget=500ms PASS messages=1000 rendered=200 archived=800");
		expect(formatResumeBudgetOverlay(profile)).toContain("session_scan=5.00ms");
	});

	it("summarizes p50 and p95 across resume profiles", () => {
		const profiles = [10, 20, 30, 40].map((duration) => ({
			totalMs: duration,
			budgetMs: 500,
			pass: true,
			metadata: {},
			stages: [{ name: "first_frame_render" as const, durationMs: duration / 2 }],
		}));

		const summary = summarizeResumeProfiles(profiles);

		expect(summary.total).toEqual({ p50Ms: 20, p95Ms: 40 });
		expect(summary.stages.first_frame_render).toEqual({ p50Ms: 10, p95Ms: 20 });
	});
});
