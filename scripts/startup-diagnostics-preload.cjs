const { appendFileSync } = require('node:fs');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');

const diagFile = process.env.SUMO_TUI_DIAG_FILE;
const entrypoint = process.argv[1] || "";
const shouldInstrument = entrypoint.includes("pi-coding-agent") || entrypoint.endsWith("/pi") || entrypoint.endsWith("/pi.js");
if (diagFile && shouldInstrument && !global.__sumocodeStartupDiagnosticsInstalled) {
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

	log('process_preload_start', { pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(0, 6) });

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
