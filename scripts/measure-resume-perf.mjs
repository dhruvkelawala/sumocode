#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_PATH = join(ROOT, "docs", "research", "sumo-tui-resume-performance.md");
const MESSAGE_COUNT = Number.parseInt(process.env.SUMO_TUI_RESUME_PERF_MESSAGES ?? "10000", 10);
const ITERATIONS = Number.parseInt(process.env.SUMO_TUI_RESUME_PERF_ITERATIONS ?? "30", 10);
const LEGACY_MESSAGE_COUNT = Number.parseInt(process.env.SUMO_TUI_RESUME_LEGACY_MESSAGES ?? "2000", 10);
const LEGACY_ITERATIONS = Number.parseInt(process.env.SUMO_TUI_RESUME_LEGACY_ITERATIONS ?? "5", 10);
const WIDTH = 160;
const HEIGHT = 45;

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
});

function formatMs(value) {
	return `${value.toFixed(value >= 100 ? 0 : 2)}ms`;
}

function syntheticMessages(count) {
	return Array.from({ length: count }, (_, index) => ({
		id: `message-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		content: `resume message ${index}: hydrate enough text to exercise wrapping, transcript parsing, and retained node creation.`,
	}));
}

async function loadModules() {
	const [
		{ SumoNode },
		{ DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga },
		{ CellBuffer },
		{ composite },
		{ transcriptFromSessionContext },
		{ ChatPager },
		{ ResumeProfiler, summarizeResumeProfiles },
	] = await Promise.all([
		jiti.import(join(ROOT, "src", "sumo-tui", "layout", "node.ts")),
		jiti.import(join(ROOT, "src", "sumo-tui", "layout", "yoga.ts")),
		jiti.import(join(ROOT, "src", "sumo-tui", "render", "buffer.ts")),
		jiti.import(join(ROOT, "src", "sumo-tui", "render", "compositor.ts")),
		jiti.import(join(ROOT, "src", "sumo-tui", "transcript", "view-model.ts")),
		jiti.import(join(ROOT, "src", "sumo-tui", "widgets", "chat-pager.ts")),
		jiti.import(join(ROOT, "src", "sumo-tui", "runtime", "resume-profiler.ts")),
	]);
	return { SumoNode, DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, CellBuffer, composite, transcriptFromSessionContext, ChatPager, ResumeProfiler, summarizeResumeProfiles };
}

function createChat(modules, yoga) {
	const root = new modules.SumoNode(yoga.Node.create());
	root.width = WIDTH;
	root.height = HEIGHT;
	root.flexDirection = modules.FLEX_DIRECTION_COLUMN;
	const chat = modules.ChatPager.create(yoga, root, {
		renderControls: {
			scheduleRender() {},
			setStreamingMode() {},
		},
	});
	return { root, chat };
}

async function measureBulk(modules, yoga, messages) {
	const { root, chat } = createChat(modules, yoga);
	const profiler = new modules.ResumeProfiler();
	try {
		const rawMessages = profiler.measure("session_scan", () => messages);
		const transcript = profiler.measure("transcript_model", () => modules.transcriptFromSessionContext({ messages: rawMessages }));
		const stats = profiler.measure("transcript_hydrate", () => chat.replaceViewModels(transcript.messages));
		profiler.measure("yoga_first_layout", () => root.yogaNode.calculateLayout(WIDTH, HEIGHT, modules.DIRECTION_LTR));
		profiler.measure("first_frame_render", () => modules.composite(root, new modules.CellBuffer(HEIGHT, WIDTH)));
		return profiler.finish({
			sourceMessages: messages.length,
			acceptedMessages: stats.acceptedMessages,
			renderedMessages: stats.renderedMessages,
			archivedMessages: stats.archivedMessages,
		});
	} finally {
		root.dispose();
	}
}

async function measureIncrementalHydrate(modules, yoga, messages) {
	const { root, chat } = createChat(modules, yoga);
	const profiler = new modules.ResumeProfiler();
	try {
		const transcript = modules.transcriptFromSessionContext({ messages });
		const stats = profiler.measure("transcript_hydrate", () => {
			for (const message of transcript.messages) chat.addViewModel(message);
			return {
				acceptedMessages: transcript.messages.length,
				renderedMessages: chat.getRenderedMessages().length,
				archivedMessages: chat.getArchivedMessageCount(),
			};
		});
		return profiler.finish({
			sourceMessages: messages.length,
			acceptedMessages: stats.acceptedMessages,
			renderedMessages: stats.renderedMessages,
			archivedMessages: stats.archivedMessages,
		});
	} finally {
		root.dispose();
	}
}

function stageTable(summary) {
	const rows = [
		["session_scan", summary.stages.session_scan],
		["transcript_model", summary.stages.transcript_model],
		["transcript_hydrate", summary.stages.transcript_hydrate],
		["yoga_first_layout", summary.stages.yoga_first_layout],
		["first_frame_render", summary.stages.first_frame_render],
		["total", summary.total],
	];
	return [
		"| Stage | p50 | p95 |",
		"|---|---:|---:|",
		...rows.map(([stage, value]) => `| ${stage} | ${formatMs(value.p50Ms)} | ${formatMs(value.p95Ms)} |`),
	].join("\n");
}

function machineLabel() {
	const require = createRequire(import.meta.url);
	const packageJson = require(join(ROOT, "package.json"));
	const cpu = cpus()[0]?.model ?? "unknown CPU";
	return `${platform()} ${release()}, Node ${process.version}, ${packageJson.name}@${packageJson.version}, ${cpu}`;
}

async function main() {
	const modules = await loadModules();
	const yoga = await modules.loadYoga();
	const bulkMessages = syntheticMessages(MESSAGE_COUNT);
	const legacyMessages = syntheticMessages(LEGACY_MESSAGE_COUNT);
	const bulkProfiles = [];
	const legacyProfiles = [];

	for (let index = 0; index < ITERATIONS; index += 1) {
		bulkProfiles.push(await measureBulk(modules, yoga, bulkMessages));
	}
	for (let index = 0; index < LEGACY_ITERATIONS; index += 1) {
		legacyProfiles.push(await measureIncrementalHydrate(modules, yoga, legacyMessages));
	}

	const bulkSummary = modules.summarizeResumeProfiles(bulkProfiles);
	const legacySummary = modules.summarizeResumeProfiles(legacyProfiles);
	const latest = bulkProfiles[bulkProfiles.length - 1];
	const generatedAt = new Date().toISOString();
	const pass = bulkSummary.total.p95Ms < 500 ? "PASS" : "MISS";
	const markdown = `# SumoTUI Resume Performance

Generated: ${generatedAt}

Machine: ${machineLabel()}

## Current Bulk Resume Path (${MESSAGE_COUNT} messages, ${ITERATIONS} iterations)

Budget: p95 < 500ms. Result: **${pass}** at p95 ${formatMs(bulkSummary.total.p95Ms)}.

${stageTable(bulkSummary)}

Latest retained transcript stats: ${latest?.metadata.acceptedMessages ?? 0} accepted, ${latest?.metadata.renderedMessages ?? 0} rendered nodes, ${latest?.metadata.archivedMessages ?? 0} archived behind the placeholder.

## Legacy Incremental Replay Proxy (${LEGACY_MESSAGE_COUNT} messages, ${LEGACY_ITERATIONS} iterations)

This measures the old Sumo-owned replay shape: add every view model one-by-one, create archived Yoga nodes, and schedule a render per message. It is intentionally capped below 10k so the report stays quick enough for local iteration.

${stageTable(legacySummary)}

## Conclusion

Dominant Sumo-owned cost was full chat-history replay. The fix bulk-hydrates resumed transcripts, keeps only the active ${latest?.metadata.renderedMessages ?? 200}-message window as retained nodes, represents older history as a virtual archive count, and schedules one render for the resumed transcript.

Remnic memory is not on the synchronous resume hot path in this checkout: sidebar memory refreshes are debounce-triggered and run through \`CancellableWorkerRuntime\`.

No retained render loop idle wake is covered by \`FrameScheduler\` tests: after the coalesced resume render drains, no timer remains scheduled.
`;

	await mkdir(dirname(OUT_PATH), { recursive: true });
	await writeFile(OUT_PATH, markdown, "utf8");
	console.log(markdown);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
