const { appendFileSync } = require('node:fs');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');

const diagFile = process.env.SUMO_TUI_DIAG_FILE;
// Windows argv paths use backslashes; normalize before role matching.
const entrypoint = (process.argv[1] || "").replace(/\\/g, "/");
const role = entrypoint.endsWith("/sumo-rpc-host.js") ? "host" : "rpc-child";
const publicStartupDiagnostics = process.env.SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS === "1";
const shouldInstrument = entrypoint.includes("pi-coding-agent") || entrypoint.endsWith("/pi") || entrypoint.endsWith("/pi.js");

if (diagFile && publicStartupDiagnostics) {
	global.__sumocodeStartupMark = (event, fields = {}) => {
		try {
			appendFileSync(diagFile, `${JSON.stringify({ ts: Date.now(), event, pid: process.pid, ...fields })}\n`, { encoding: "utf8", mode: 0o600 });
		} catch {}
	};
	global.__sumocodeStartupMark(role === "host" ? "process_preload_start" : "child_entry", { role });
} else if (diagFile && shouldInstrument && !global.__sumocodeStartupDiagnosticsInstalled) {
	global.__sumocodeStartupDiagnosticsInstalled = true;
	const startedAt = performance.now();
	let lastMark = startedAt;
	const originalLoad = Module._load;
	const stats = { count: 0, totalMs: 0, maxMs: 0, slowest: undefined };

	function round(value) {
		return Math.round(value * 100) / 100;
	}

	function log(event, fields = {}) {
		try {
			const now = performance.now();
			appendFileSync(diagFile, `${JSON.stringify({
				ts: Date.now(),
				event,
				sinceProcessPreloadMs: round(now - startedAt),
				deltaMs: round(now - lastMark),
				...fields,
			})}\n`, 'utf8');
			lastMark = now;
		} catch {}
	}

	log('process_preload_start', { role, pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(0, 6) });

	Module._load = function sumocodeInstrumentedModuleLoad(request, parent, isMain) {
		const start = performance.now();
		try {
			return originalLoad.apply(this, arguments);
		} finally {
			const durationMs = performance.now() - start;
			stats.count += 1;
			stats.totalMs += durationMs;
			if (durationMs > stats.maxMs) {
				stats.maxMs = durationMs;
				stats.slowest = request;
			}
			if (durationMs >= 20) {
				log('process_module_load_slow', {
					spec: String(request),
					durationMs: round(durationMs),
					parent: parent?.filename,
					isMain: Boolean(isMain),
				});
			}
		}
	};

	function flushSummary() {
		log('process_module_load_summary', {
			count: stats.count,
			totalMs: round(stats.totalMs),
			maxMs: round(stats.maxMs),
			slowestSpec: stats.slowest,
		});
	}

	process.once('beforeExit', flushSummary);
	process.once('exit', flushSummary);
}
