import { judgeChoice, type ChoiceClassifier, type ChoiceQuestion, type JudgmentState } from "../../judgment.js";
import type { RpcDeliveryDecider } from "./prompt-scheduler.js";

const DELIVERY_QUESTION: ChoiceQuestion<"steer" | "follow_up"> = {
	instructions: "A coding agent is busy with `current_task` when the user sends `message`. Should the message reach the agent now, at its next step (steer), or wait until the current task is finished (follow_up)?",
	criteria: {
		steer: "Corrects, redirects, constrains, cancels, or adds detail to the work in progress.",
		follow_up: "A separate request or next step that should start only after the current task is done.",
	},
};

// ponytail: untuned bar. Two-option confidence is 2p - 1, so 0.6 means p >= 0.8.
// Only follow-up needs it: a wrong steer costs little, a wrong follow-up lets the agent finish a dead end.
const FOLLOW_UP_MIN_CONFIDENCE = 0.6;
const MAX_FIELD_CHARS = 4_000;
// A steer lands only at the agent's next turn boundary, so waiting out a cold Jev call (~500ms) costs nothing.
const DECISION_TIMEOUT_MS = 1_500;

/** `auto` queue mode: Jev picks follow-up when it is confident, otherwise the message steers. */
export function createJevDeliveryDecider(classify: ChoiceClassifier): RpcDeliveryDecider {
	return async (message, currentTask) => {
		const state: JudgmentState = currentTask === undefined
			? { message: message.slice(0, MAX_FIELD_CHARS) }
			: { current_task: currentTask.slice(0, MAX_FIELD_CHARS), message: message.slice(0, MAX_FIELD_CHARS) };
		const answer = await judgeChoice(classify, state, DELIVERY_QUESTION, DECISION_TIMEOUT_MS);
		return answer?.choice === "follow_up" && answer.confidence >= FOLLOW_UP_MIN_CONFIDENCE ? "followUp" : "steer";
	};
}
