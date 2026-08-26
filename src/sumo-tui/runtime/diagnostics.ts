import { appendFileSync } from "node:fs";

type DiagnosticValue = string | number | boolean | null | undefined | DiagnosticValue[] | { readonly [key: string]: DiagnosticValue };
type DiagnosticFields = { readonly [key: string]: DiagnosticValue };

const PREVIEW_MAX = 160;

function diagnosticsFile(): string | undefined {
	const file = process.env.SUMO_TUI_DIAG_FILE;
	return file && file.trim().length > 0 ? file : undefined;
}

export function isDiagnosticsEnabled(): boolean {
	return diagnosticsFile() !== undefined;
}

function isDiagnosticString(value: DiagnosticValue): value is string {
	return typeof value === "string";
}

function isScalarDiagnosticValue(value: DiagnosticValue): value is number | boolean | null | undefined {
	return typeof value === "number" || typeof value === "boolean" || value === null || value === undefined;
}

function sanitizeDiagnosticValue(value: DiagnosticValue): DiagnosticValue {
	if (isDiagnosticString(value)) return value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX)}…` : value;
	if (isScalarDiagnosticValue(value)) return value;
	if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry));
	const next: { [key: string]: DiagnosticValue } = {};
	for (const [key, entry] of Object.entries(value)) next[key] = sanitizeDiagnosticValue(entry);
	return next;
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
		// `mode` only applies when the append creates the file: the trace carries
		// low-level input events, so it must be readable by its owner only.
		appendFileSync(file, `${JSON.stringify({ ts: Date.now(), event, sinceDiagnosticsMs: Math.round((now - diagnosticsStart) * 100) / 100, deltaMs: Math.round((now - lastMark) * 100) / 100, ...sanitized })}\n`, { encoding: "utf8", mode: 0o600 });
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

type AnyPiEventListener = (...args: never[]) => void;

/**
 * Wraps a single listener so each invocation is traced. Returns `undefined`
 * when diagnostics are disabled so callers can skip patching entirely.
 */
export function createPiEventInstrumentation(): { wrap(eventName: string, listener: AnyPiEventListener): AnyPiEventListener } | undefined {
	if (!isDiagnosticsEnabled()) return undefined;
	const instrumented = new WeakSet<AnyPiEventListener>();
	return {
		wrap(eventName, listener) {
			if (instrumented.has(listener)) return listener;
			instrumented.add(listener);
			return (...args: never[]): void => {
				logDiagnostic("pi_event", { name: eventName });
				listener(...args);
			};
		},
	};
}

/** Emitted once per successful emitter instrumentation. */
export function logPiEventInstrumented(): void {
	logDiagnostic("pi_event_instrumentation", { enabled: true });
}
