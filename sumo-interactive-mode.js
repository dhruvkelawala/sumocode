import { appendFileSync } from "node:fs";

const bootstrapStart = performance.now();
const diagFile = process.env.SUMO_TUI_DIAG_FILE;
let realModulePromise;
let earlySplashPainted = false;

function logBootstrap(event, fields = {}) {
	if (!diagFile) return;
	try {
		appendFileSync(diagFile, `${JSON.stringify({ ts: Date.now(), event, sinceBootstrapMs: Math.round((performance.now() - bootstrapStart) * 100) / 100, ...fields })}\n`, "utf8");
	} catch {}
}

function center(text, width) {
	const left = Math.max(0, Math.floor((width - text.length) / 2));
	return `${" ".repeat(left)}${text}`.slice(0, width);
}

function paintEarlySplash(output = process.stdout) {
	if (earlySplashPainted || output?.isTTY !== true) return;
	earlySplashPainted = true;
	const width = Math.max(1, output.columns ?? 80);
	const height = Math.max(1, output.rows ?? 24);
	const top = Math.max(1, Math.floor(height / 2) - 2);
	const lines = [
		"SUMOCODE",
		"cathedral runtime loading",
		"",
		"press ctrl+c to exit",
	];
	const body = lines.map((line, index) => `\x1b[${top + index};1H\x1b[2K${center(line, width)}`).join("");
	output.write(
		"\x1b[?1049h" +
		"\x1b[?2004h" +
		"\x1b[>7u" +
		"\x1b[>4;2m" +
		"\x1b[?25h\x1b[H" +
		"\x1b]11;#1A1511\x1b\\" +
		"\x1b[2J" +
		"\x1b[38;2;217;119;6m" +
		body +
		"\x1b[0m",
	);
	logBootstrap("early_splash_paint", { width, height });
}

async function loadRealModule() {
	if (!realModulePromise) {
		realModulePromise = (async () => {
			logBootstrap("jiti_import_start");
			const { createJiti } = await import("jiti");
			logBootstrap("jiti_import_end");
			logBootstrap("jiti_create_start");
			const jiti = createJiti(import.meta.url, {
				moduleCache: true,
				// Node's native TypeScript loader is strip-only and cannot handle parameter
				// properties used in SumoInteractiveMode, so keep transpilation on jiti.
				tryNative: false,
			});
			logBootstrap("jiti_create_end");
			logBootstrap("sumo_module_import_start");
			const mod = await jiti.import("./src/sumo-tui/pi-compat/sumo-interactive-mode.ts");
			logBootstrap("sumo_module_import_end");
			return mod;
		})();
	}
	return realModulePromise;
}

export class SumoInteractiveMode {
	constructor(...args) {
		this.args = args;
		this.real = undefined;
		logBootstrap("sumo_bootstrap_start", { pid: process.pid, cwd: process.cwd() });
		paintEarlySplash(process.stdout);
	}

	async ensureReal() {
		if (!this.real) {
			const mod = await loadRealModule();
			this.real = new mod.SumoInteractiveMode(...this.args);
		}
		return this.real;
	}

	async init() {
		return (await this.ensureReal()).init();
	}

	async run() {
		return (await this.ensureReal()).run();
	}

	stop() {
		this.real?.stop();
	}

	createExtensionUIContext(options) {
		if (!this.real) throw new Error("SumoInteractiveMode is not initialized yet");
		return this.real.createExtensionUIContext(options);
	}

	getRetainedUIContext() {
		return this.real?.getRetainedUIContext();
	}

	getRetainedRuntimeSnapshot() {
		return this.real?.getRetainedRuntimeSnapshot();
	}

	isRetainedExtensionUIEnabled() {
		return this.real?.isRetainedExtensionUIEnabled() === true;
	}
}

export function sumoInteractiveMode(...args) {
	return new SumoInteractiveMode(...args);
}
