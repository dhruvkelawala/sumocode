import type { TranscriptViewModel } from "../transcript/view-model.js";
import type { RpcHostChromeState } from "./state.js";

export interface RpcVisualFixture {
	readonly transcript: TranscriptViewModel;
	readonly state: RpcHostChromeState;
	readonly inputPreview?: string;
}

const FIXTURE_TIMES = {
	userOne: new Date("2026-04-30T11:41:00"),
	sumoOne: new Date("2026-04-30T11:42:00"),
	userTwo: new Date("2026-04-30T11:42:30"),
	sumoTwo: new Date("2026-04-30T11:43:00"),
};

const COMPLETED_ACTIVE_TRANSCRIPT: TranscriptViewModel = {
	messages: [
		{
			id: "u1",
			role: "user",
			displayName: "USER",
			timestamp: FIXTURE_TIMES.userOne,
			blocks: [{ type: "markdown", text: "hello, refactor the auth flow to use the new session pattern." }],
		},
		{
			id: "s1",
			role: "sumo",
			displayName: "SUMO",
			timestamp: FIXTURE_TIMES.sumoOne,
			blocks: [
				{ type: "markdown", text: "Reading the auth flow." },
				{ type: "activity", activity: { id: "read-session", kind: "tool", title: "read", status: "succeeded", invocation: { path: "src/auth/session.ts" }, subject: "src/auth/session.ts", body: { kind: "source", text: "" } } },
				{ type: "activity", activity: { id: "edit-session", kind: "tool", title: "edit", status: "succeeded", invocation: { path: "src/auth/session.ts" }, subject: "src/auth/session.ts", outputTail: "+14 -6 session flow updated", body: { kind: "diff", text: "+14 -6 session flow updated" } } },
				{ type: "markdown", text: "Done. Updated 14 lines, deleted 6 stale helpers." },
			],
		},
		{
			id: "u2",
			role: "user",
			displayName: "USER",
			timestamp: FIXTURE_TIMES.userTwo,
			blocks: [{ type: "markdown", text: "run tests" }],
		},
		{
			id: "s2",
			role: "sumo",
			displayName: "SUMO",
			timestamp: FIXTURE_TIMES.sumoTwo,
			blocks: [
				{ type: "markdown", text: "Running tests now." },
				{
					type: "activity",
					activity: {
						id: "bash-test",
						kind: "tool",
						title: "bash",
						status: "succeeded",
						invocation: { command: "pnpm test src/auth" },
						subject: "pnpm test src/auth",
						outputTail: "✓ src/auth/session.test.ts (22 tests)\n22 passed in 1.2s",
						body: { kind: "terminal", command: "pnpm test src/auth", text: "✓ src/auth/session.test.ts (22 tests)\n22 passed in 1.2s" },
						result: { summary: "22 tests, 1.2s" },
					},
				},
				{ type: "markdown", text: "All 22 tests pass." },
			],
		},
	],
};

const COMPLETED_ACTIVE_STATE: RpcHostChromeState = {
	sessionId: "fixture",
	sessionName: "019dd3d8",
	modelLabel: "gpt-5.5",
	thinkingLevel: "medium",
	isStreaming: false,
	isCompacting: false,
	messageCount: COMPLETED_ACTIVE_TRANSCRIPT.messages.length,
	pendingMessageCount: 0,
	hasMessages: true,
	gitBranch: "main",
	taskPartialCount: 0,
	contextTokens: 42000,
	contextWindow: 200000,
	costUsd: 0.42,
};

export function rpcVisualFixtureFromEnv(env: NodeJS.ProcessEnv): RpcVisualFixture | undefined {
	if (env.SUMOCODE_HARNESS !== "1") return undefined;
	const fixtureId = env.SUMOCODE_VISUAL_RPC_FIXTURE;
	if (!fixtureId) return undefined;
	if (fixtureId !== "completed-active") throw new Error(`Unsupported RPC visual fixture: ${fixtureId}`);
	const inputPreview = env.SUMOCODE_VISUAL_RPC_INPUT_PREVIEW;
	return {
		transcript: COMPLETED_ACTIVE_TRANSCRIPT,
		state: COMPLETED_ACTIVE_STATE,
		...(inputPreview && inputPreview.length > 0 ? { inputPreview } : {}),
	};
}
