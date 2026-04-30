import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { transcriptFromSessionContext, type ChatMessageViewModel } from "../transcript/view-model.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { ResumeProfiler, summarizeResumeProfiles, type ResumeProfile } from "./resume-profiler.js";

const MESSAGE_COUNT = Number.parseInt(process.env.SUMO_TUI_RESUME_PERF_MESSAGES ?? "10000", 10);
const ITERATIONS = Number.parseInt(process.env.SUMO_TUI_RESUME_PERF_ITERATIONS ?? "8", 10);
const WIDTH = 160;
const HEIGHT = 45;

interface SyntheticPiMessage {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly content: string;
}

function syntheticMessages(count: number): SyntheticPiMessage[] {
	// Fixed markdown messages keep the CI budget stable; mixed tool/code/skill
	// transcripts belong in a future realism benchmark, not this regression gate.
	return Array.from({ length: count }, (_, index) => ({
		id: `message-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		content: `resume message ${index}: hydrate enough text to exercise wrapping, transcript parsing, and retained node creation.`,
	}));
}

async function createChat(yoga: Yoga): Promise<{ root: SumoNode; chat: ChatPager }> {
	const root = new SumoNode(yoga.Node.create());
	root.width = WIDTH;
	root.height = HEIGHT;
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	return {
		root,
		chat: ChatPager.create(yoga, root, {
			renderControls: {
				scheduleRender(): void {},
				setStreamingMode(): void {},
			},
		}),
	};
}

async function measureResume(yoga: Yoga, messages: readonly SyntheticPiMessage[]): Promise<ResumeProfile> {
	const { root, chat } = await createChat(yoga);
	const profiler = new ResumeProfiler();
	try {
		const rawMessages = profiler.measure("session_scan", () => messages);
		const transcript = profiler.measure("transcript_model", () => transcriptFromSessionContext({ messages: rawMessages }));
		const stats = profiler.measure("transcript_hydrate", () => chat.replaceViewModels(transcript.messages as readonly ChatMessageViewModel[]));
		profiler.measure("yoga_first_layout", () => root.yogaNode.calculateLayout(WIDTH, HEIGHT, DIRECTION_LTR));
		profiler.measure("first_frame_render", () => composite(root, new CellBuffer(HEIGHT, WIDTH)));
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

describe("resume flow performance", () => {
	it("keeps 10k-message resume hydration plus first frame under the 500ms p95 budget", async () => {
		const yoga = await loadYoga();
		const messages = syntheticMessages(MESSAGE_COUNT);
		const profiles: ResumeProfile[] = [];

		for (let index = 0; index < ITERATIONS; index += 1) {
			profiles.push(await measureResume(yoga, messages));
		}

		const summary = summarizeResumeProfiles(profiles);
		expect(summary.total.p95Ms, `resume p95=${summary.total.p95Ms}ms, stages=${JSON.stringify(summary.stages)}`).toBeLessThan(500);
		expect(Math.max(...profiles.map((profile) => profile.metadata.renderedMessages ?? 0))).toBeLessThanOrEqual(200);
	});
});
