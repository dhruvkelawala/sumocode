import { appendFileSync } from "node:fs";

const diagFile = process.env.SUMO_TUI_DIAG_FILE;
const enabled = typeof diagFile === "string" && diagFile.trim().length > 0;
const maxTimerEvents = Number.parseInt(process.env.SUMO_TUI_DIAG_TIMER_MAX_EVENTS ?? "50000", 10);
let timerEventsLogged = 0;
let timerEventsDropped = 0;
let nextTimerId = 1;

function log(event, fields = {}) {
	if (!enabled) return;
	try {
		appendFileSync(diagFile, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`, "utf8");
	} catch {
		// Diagnostics must never keep the child process alive or crash it.
	}
}

function captureStack() {
	const stack = new Error().stack ?? "";
	return stack
		.split("\n")
		.slice(3, 12)
		.map((line) => line.trim())
		.join(" | ");
}

function logTimerFire(kind, id, delay, stack) {
	if (!enabled) return;
	if (timerEventsLogged >= maxTimerEvents) {
		timerEventsDropped += 1;
		if (timerEventsDropped === 1 || timerEventsDropped % 1000 === 0) log("timer_fire_dropped", { dropped: timerEventsDropped });
		return;
	}
	timerEventsLogged += 1;
	log("timer_fire", { kind, id, delay: Number(delay ?? 0), stack });
}

if (enabled && !globalThis.__sumoTuiTimerDiagnosticsInstalled) {
	globalThis.__sumoTuiTimerDiagnosticsInstalled = true;
	const originalSetInterval = globalThis.setInterval.bind(globalThis);
	const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
	const originalClearInterval = globalThis.clearInterval.bind(globalThis);
	const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);

	globalThis.setInterval = (callback, delay, ...args) => {
		if (typeof callback !== "function") return originalSetInterval(callback, delay, ...args);
		const id = nextTimerId++;
		const stack = captureStack();
		log("timer_create", { kind: "interval", id, delay: Number(delay ?? 0), stack });
		return originalSetInterval((...callbackArgs) => {
			logTimerFire("interval", id, delay, stack);
			return callback(...callbackArgs);
		}, delay, ...args);
	};

	globalThis.setTimeout = (callback, delay, ...args) => {
		if (typeof callback !== "function") return originalSetTimeout(callback, delay, ...args);
		const id = nextTimerId++;
		const stack = captureStack();
		log("timer_create", { kind: "timeout", id, delay: Number(delay ?? 0), stack });
		return originalSetTimeout((...callbackArgs) => {
			logTimerFire("timeout", id, delay, stack);
			return callback(...callbackArgs);
		}, delay, ...args);
	};

	globalThis.clearInterval = (timer) => originalClearInterval(timer);
	globalThis.clearTimeout = (timer) => originalClearTimeout(timer);
	log("timer_instrumentation", { enabled: true, maxTimerEvents });
}
