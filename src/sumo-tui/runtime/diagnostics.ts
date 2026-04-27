import { appendFileSync } from "node:fs";

const PI_EVENT_INSTRUMENTED_PROPERTY = "__sumoTuiDiagnosticsPiEventsInstrumented";

type DiagnosticValue = string | number | boolean | null | undefined;
type DiagnosticFields = Record<string, DiagnosticValue>;

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

export function logDiagnostic(event: string, fields: DiagnosticFields = {}): void {
	const file = diagnosticsFile();
	if (!file) return;
	try {
		appendFileSync(file, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`, "utf8");
	} catch {
		// Diagnostics must never perturb the interactive session.
	}
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
