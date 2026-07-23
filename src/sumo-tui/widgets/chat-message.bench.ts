// Micro-benchmark for the ChatMessage.renderRows memoization (audit batch B8).
// NOT part of the test suite — vitest.config.ts only includes `*.test.ts`, so
// this file is inert under `pnpm test` / `pnpm test:integration`. Run manually:
//   pnpm vitest bench --run src/sumo-tui/widgets/chat-message.bench.ts
// or ad hoc via `pnpm exec tsx` if preferred. Left uncommitted per task instructions.
import { loadYoga } from "../layout/yoga.js";
import { SumoNode } from "../layout/node.js";
import { CellBuffer } from "../render/buffer.js";
import { ChatMessage } from "./chat-message.js";

const MESSAGE_COUNT = 50;
const CYCLES = 200;
const WIDTH = 100;
const HEIGHT = 40;

function fixtureBlocksFor(index: number) {
	return [
		{ type: "markdown" as const, text: `# Message ${index}\n**bold** text with some *emphasis* and a [link](https://example.com/${index}).\n\nA second paragraph with more prose to push the markdown parser: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.` },
		{ type: "code" as const, lang: "ts", source: `function handler${index}(input: string): string {\n  return input.trim().toUpperCase();\n}` },
		{ type: "activity" as const, activity: { id: `read-${index}`, kind: "tool" as const, title: "read", status: "succeeded" as const, invocation: { path: `src/file-${index}.ts` }, subject: `src/file-${index}.ts`, body: { kind: "source" as const, text: "file contents" } } },
	];
}

async function main(): Promise<void> {
	const yoga = await loadYoga();
	const root = new SumoNode(yoga.Node.create());
	root.width = WIDTH;
	root.height = HEIGHT;

	const messages: ChatMessage[] = [];
	for (let index = 0; index < MESSAGE_COUNT; index += 1) {
		messages.push(ChatMessage.create(yoga, "sumo", "", root, new Date(), fixtureBlocksFor(index)));
	}

	const buffer = new CellBuffer(HEIGHT, WIDTH);

	// Mirrors the reported defect: within a single frame, `getEstimatedHeight`
	// is typically called more than once per message (e.g. chat-pager's
	// `setToolExpansion`/`getRenderedEstimatedHeight` loop measuring
	// before-height and after-height across all active messages) before
	// `render` paints. Three getEstimatedHeight calls + one render per message
	// per cycle approximates that per-frame call fan-out.
	const start = process.hrtime.bigint();
	for (let cycle = 0; cycle < CYCLES; cycle += 1) {
		for (const message of messages) {
			message.getEstimatedHeight(WIDTH);
			message.getEstimatedHeight(WIDTH);
			message.getEstimatedHeight(WIDTH);
			message.render(buffer, { top: 0, left: 0, width: WIDTH, height: HEIGHT });
		}
	}
	const end = process.hrtime.bigint();

	const totalMs = Number(end - start) / 1e6;
	// eslint-disable-next-line no-console
	console.log(JSON.stringify({
		messageCount: MESSAGE_COUNT,
		cycles: CYCLES,
		totalMs: Math.round(totalMs * 100) / 100,
		msPerCycle: Math.round((totalMs / CYCLES) * 1000) / 1000,
	}));

	root.dispose();
}

main().catch((error) => {
	// eslint-disable-next-line no-console
	console.error(error);
	process.exitCode = 1;
});
