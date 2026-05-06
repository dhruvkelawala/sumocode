import { appendFileSync } from "node:fs";

const PI_EVENT_INSTRUMENTED_PROPERTY = "__sumoTuiDiagnosticsPiEventsInstrumented";

type DiagnosticValue = string | number | boolean | null | undefined | DiagnosticValue[] | { readonly [key: string]: DiagnosticValue };
type DiagnosticFields = Record<string, unknown>;

const PREVIEW_MAX = 160;

interface InstrumentablePiEventEmitter {
	on?: unknown;
	[PI_EVENT_INSTRUMENTED_PROPERTY]?: true;
}

function diagnosticsFile(): string | undefined {
	const file = process.env.SUMO_TUI_DIAG_FILE;
	return file && file.trim().length > 0 ? file : undefined;
}

export function isDiagnosticsEnabled(): boolean {
	return diagnosticsFile() !== undefined;
}

function sanitizeDiagnosticValue(value: unknown): DiagnosticValue {
	if (typeof value === "string") return value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX)}…` : value;
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry));
	if (typeof value === "object") {
		const next: Record<string, DiagnosticValue> = {};
		for (const [key, entry] of Object.entries(value)) next[key] = sanitizeDiagnosticValue(entry);
		return next;
	}
	return String(value);
}

const diagnosticsStart = performance.now();
let lastMark = diagnosticsStart;

export function logDiagnostic(event: string, fields: DiagnosticFields = {}): void {
	const file = diagnosticsFile();
	if (!file) return;
	try {
		const now = performance.now();
		const sanitized: Record<string, DiagnosticValue> = {};
		for (const [key, value] of Object.entries(fields)) sanitized[key] = sanitizeDiagnosticValue(value);
		appendFileSync(file, `${JSON.stringify({ ts: Date.now(), event, sinceDiagnosticsMs: Math.round((now - diagnosticsStart) * 100) / 100, deltaMs: Math.round((now - lastMark) * 100) / 100, ...sanitized })}\n`, "utf8");
		lastMark = now;
	} catch {
		// Diagnostics must never perturb the interactive session.
	}
}

export function logRuntimeStart(fields: DiagnosticFields = {}): void {
	logDiagnostic("runtime_start", {
		branch: process.env.SUMOCODE_DEBUG_BRANCH,
		commit: process.env.SUMOCODE_DEBUG_COMMIT,
		pid: process.pid,
		cwd: process.cwd(),
		sumoTui: process.env.SUMO_TUI,
		...fields,
	});
}

export function instrumentPiEventEmitter(pi: unknown): void {
	if (!isDiagnosticsEnabled()) return;
	const target = pi as InstrumentablePiEventEmitter;
	if (target[PI_EVENT_INSTRUMENTED_PROPERTY] || typeof target.on !== "function") return;
	const originalOn = target.on.bind(pi) as (eventName: unknown, listener: unknown, ...args: unknown[]) => unknown;
	target.on = (eventName: unknown, listener: unknown, ...args: unknown[]): unknown => {
		if (typeof listener !== "function") return originalOn(eventName, listener, ...args);
		const name = String(eventName);
		const wrappedListener = (...listenerArgs: unknown[]): unknown => {
			logDiagnostic("pi_event", { name });
			return (listener as (...wrappedArgs: unknown[]) => unknown)(...listenerArgs);
		};
		return originalOn(eventName, wrappedListener, ...args);
	};
	target[PI_EVENT_INSTRUMENTED_PROPERTY] = true;
	logDiagnostic("pi_event_instrumentation", { enabled: true });
}
