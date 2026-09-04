import { appendFileSync } from "node:fs";

type DiagnosticValue = string | number | boolean | null | undefined | DiagnosticValue[] | { readonly [key: string]: DiagnosticValue };
type DiagnosticFields = { readonly [key: string]: DiagnosticValue };

const PREVIEW_MAX = 160;
const PUBLIC_STARTUP_EVENTS = new Set([
	"process_preload_start",
	"child_spawn_start",
	"child_spawned",
	"child_entry",
	"bedrock_import_start",
	"after_bedrock_import",
	"cli_import_start",
	"after_cli_import",
	"main_enter",
	"model_runtime_create_start",
	"model_refresh_1_start",
	"model_refresh_1_end",
	"model_runtime_create_end",
	"extension_import_start",
	"extension_import_end",
	"extension_factory_start",
	"extension_factory_end",
	"model_refresh_2_start",
	"model_refresh_2_end",
	"run_rpc_mode_enter",
	"first_get_state_received",
	"rpc_child_ready",
	"terminal_index_start",
	"terminal_index_ready",
	"editor_ready",
	"slash_ready",
	"hydration_committed",
	"command_ready",
]);

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
	const publicStartupDiagnostics = process.env.SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS === "1";
	if (publicStartupDiagnostics && !PUBLIC_STARTUP_EVENTS.has(event)) return;
	try {
		const now = performance.now();
		const sanitized: Record<string, DiagnosticValue> = {};
		if (publicStartupDiagnostics) {
			// Only the scan's high-resolution duration and accepted-record count are
			// public-safe; every other field stays process-local.
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- diagnostics-file boundary: fields arrive from a caller-supplied DiagnosticFields record, not a parsed domain value.
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- diagnostics-file boundary: fields arrive from a caller-supplied DiagnosticFields record, not a parsed domain value.
			const durationMsValid = typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs);
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- same boundary as above for the accepted-record count.
			const snapshotCountValid = typeof fields.snapshotCount === "number" && Number.isFinite(fields.snapshotCount);
			if (event === "terminal_index_ready" && durationMsValid && snapshotCountValid) {
				sanitized.durationMs = fields.durationMs;
				sanitized.snapshotCount = fields.snapshotCount;
			}
		} else {
			for (const [key, value] of Object.entries(fields)) sanitized[key] = sanitizeDiagnosticValue(value);
		}
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
			// Returns the listener's result (including promises from async listeners):
			// result-bearing gates such as the tool_call block decision flow through
			// the instrumentation wrapper unchanged.
			// oxlint-disable-next-line anti-slop/no-unknown-returns -- transparent instrumentation: the wrapper must pass through whatever the wrapped Pi listener returns (void, gate decision objects, or promises) without narrowing it.
			return (...args: never[]): unknown => {
				logDiagnostic("pi_event", { name: eventName });
				return listener(...args);
			};
		},
	};
}

/** Emitted once per successful emitter instrumentation. */
export function logPiEventInstrumented(): void {
	logDiagnostic("pi_event_instrumentation", { enabled: true });
}
