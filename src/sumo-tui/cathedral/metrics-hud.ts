import { activeThemeColors } from "../../themes/index.js";
import { colorHex, padAnsiToWidth, renderSidebarSectionHeader, SIDEBAR_INDENT } from "./ansi.js";

export interface MetricsHudSnapshot {
	readonly cpuPercent: number;
	readonly memoryMiB: number;
	readonly fps: number;
	readonly cpuHistory: readonly number[];
	readonly memoryHistory: readonly number[];
	readonly fpsHistory: readonly number[];
}

export interface MetricsHudOptions {
	readonly getRendersPerSecond?: () => number;
	readonly sampleIntervalMs?: number;
	readonly setInterval?: typeof setInterval;
	readonly clearInterval?: typeof clearInterval;
	readonly now?: () => number;
	readonly cpuUsage?: () => NodeJS.CpuUsage;
	readonly memoryUsage?: () => NodeJS.MemoryUsage;
}

const HISTORY_SIZE = 10;
const SPARKLINE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function pushSample(history: number[], value: number): void {
	history.push(Number.isFinite(value) ? value : 0);
	while (history.length > HISTORY_SIZE) history.shift();
}

function paddedHistory(values: readonly number[]): number[] {
	const recent = values.slice(-HISTORY_SIZE);
	return [...Array(Math.max(0, HISTORY_SIZE - recent.length)).fill(0), ...recent];
}

export function renderSparkline(values: readonly number[], maxValue: number): string {
	const max = maxValue > 0 ? maxValue : 1;
	return paddedHistory(values)
		.map((value) => SPARKLINE[Math.round(clamp(value / max, 0, 1) * (SPARKLINE.length - 1))] ?? SPARKLINE[0])
		.join("");
}

export function cpuMetricColor(cpuPercent: number): string {
	if (cpuPercent < 5) return activeThemeColors().foregroundDim;
	if (cpuPercent <= 20) return activeThemeColors().states.thinking;
	return activeThemeColors().states.approval;
}

export function memoryMetricColor(memoryMiB: number): string {
	if (memoryMiB < 200) return activeThemeColors().foregroundDim;
	if (memoryMiB <= 300) return activeThemeColors().states.thinking;
	return activeThemeColors().states.approval;
}

export function fpsMetricColor(fps: number): string {
	if (fps === 0) return activeThemeColors().foregroundDim;
	if (fps <= 5) return activeThemeColors().states.idle;
	if (fps <= 30) return activeThemeColors().states.thinking;
	return activeThemeColors().states.approval;
}

function formatCpu(cpuPercent: number): string {
	return `${cpuPercent.toFixed(cpuPercent >= 10 ? 0 : 1)}%`;
}

function formatMemory(memoryMiB: number): string {
	return `${Math.round(memoryMiB)}M`;
}

function formatFps(fps: number): string {
	return `${Math.round(fps)}/s`;
}

function metricRow(label: "CPU" | "MEM" | "FPS", sparkline: string, value: string, color: string, width: number): string {
	const innerWidth = Math.max(1, width - SIDEBAR_INDENT.length);
	const prefix = `${label.padEnd(3)}  ${colorHex(sparkline, color)}  `;
	const valueText = colorHex(value, color);
	const gap = Math.max(1, innerWidth - label.length - 2 - sparkline.length - 2 - value.length);
	return padAnsiToWidth(`${SIDEBAR_INDENT}${prefix}${" ".repeat(gap)}${valueText}`, width);
}

export function renderMetricsHudLines(snapshot: MetricsHudSnapshot | undefined, width: number): string[] {
	const metrics = snapshot ?? {
		cpuPercent: 0,
		memoryMiB: 0,
		fps: 0,
		cpuHistory: [],
		memoryHistory: [],
		fpsHistory: [],
	};

	// CATHEDRAL_UX_SPEC.md §4.2 section header shape, extended by issue #56's
	// htop-style METRICS panel below MCP.
	return [
		renderSidebarSectionHeader("METRICS", width),
		metricRow("CPU", renderSparkline(metrics.cpuHistory, 100), formatCpu(metrics.cpuPercent), cpuMetricColor(metrics.cpuPercent), width),
		metricRow("MEM", renderSparkline(metrics.memoryHistory, 512), formatMemory(metrics.memoryMiB), memoryMetricColor(metrics.memoryMiB), width),
		metricRow("FPS", renderSparkline(metrics.fpsHistory, 60), formatFps(metrics.fps), fpsMetricColor(metrics.fps), width),
	];
}

export class MetricsHud {
	private readonly getRendersPerSecond: () => number;
	private readonly sampleIntervalMs: number;
	private readonly setTimer: typeof setInterval;
	private readonly clearTimer: typeof clearInterval;
	private readonly now: () => number;
	private readonly cpuUsageFn: () => NodeJS.CpuUsage;
	private readonly memoryUsageFn: () => NodeJS.MemoryUsage;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastCpu: NodeJS.CpuUsage;
	private lastWallMs: number;
	private cpuPercent = 0;
	private memoryMiB = 0;
	private fps = 0;
	private readonly cpuHistory: number[] = [];
	private readonly memoryHistory: number[] = [];
	private readonly fpsHistory: number[] = [];

	public constructor(options: MetricsHudOptions = {}) {
		this.getRendersPerSecond = options.getRendersPerSecond ?? (() => 0);
		this.sampleIntervalMs = options.sampleIntervalMs ?? 1_000;
		this.setTimer = options.setInterval ?? setInterval;
		this.clearTimer = options.clearInterval ?? clearInterval;
		this.now = options.now ?? (() => Date.now());
		this.cpuUsageFn = options.cpuUsage ?? (() => process.cpuUsage());
		this.memoryUsageFn = options.memoryUsage ?? (() => process.memoryUsage());
		this.lastCpu = this.cpuUsageFn();
		this.lastWallMs = this.now();
	}

	public start(onSample?: () => void): void {
		if (this.timer) return;
		this.sample();
		this.timer = this.setTimer(() => {
			this.sample();
			onSample?.();
		}, this.sampleIntervalMs);
		this.timer.unref?.();
	}

	public stop(): void {
		if (!this.timer) return;
		this.clearTimer(this.timer);
		this.timer = undefined;
	}

	public sample(): MetricsHudSnapshot {
		const nowMs = this.now();
		const usage = this.cpuUsageFn();
		const elapsedMicros = Math.max(1, (nowMs - this.lastWallMs) * 1000);
		const cpuDeltaMicros = Math.max(0, (usage.user - this.lastCpu.user) + (usage.system - this.lastCpu.system));
		this.cpuPercent = (cpuDeltaMicros / elapsedMicros) * 100;
		this.memoryMiB = this.memoryUsageFn().rss / 1024 / 1024;
		this.fps = this.getRendersPerSecond();
		this.lastCpu = usage;
		this.lastWallMs = nowMs;

		pushSample(this.cpuHistory, this.cpuPercent);
		pushSample(this.memoryHistory, this.memoryMiB);
		pushSample(this.fpsHistory, this.fps);
		return this.snapshot();
	}

	public snapshot(): MetricsHudSnapshot {
		return {
			cpuPercent: this.cpuPercent,
			memoryMiB: this.memoryMiB,
			fps: this.fps,
			cpuHistory: [...this.cpuHistory],
			memoryHistory: [...this.memoryHistory],
			fpsHistory: [...this.fpsHistory],
		};
	}
}
