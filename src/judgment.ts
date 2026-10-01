/**
 * Jev judgments for runtime decisions: one typed choice with bounded latency.
 * A judgment resolves to `undefined` instead of throwing, so every caller keeps
 * its own default when the classifier is slow, unreachable, or unsure.
 */

/** TypeSafe's API root; its SDKs read an override from `TYPESAFE_BASE_URL`. */
const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 600;

/** Named text fields the classifier reads; questions reference them as `field`. */
export type JudgmentState = Readonly<Record<string, string>>;

export interface ChoiceQuestion<Option extends string> {
	readonly instructions: string;
	/** Each option with the situation it covers. */
	readonly criteria: Readonly<Record<Option, string>>;
}

export interface ChoiceAnswer<Option extends string> {
	readonly choice: Option;
	/** 0 when the options are tied, 1 when one option takes all the probability. */
	readonly confidence: number;
}

/** Transport seam: one classifier call for one choice question. */
export type ChoiceClassifier = (
	state: JudgmentState,
	question: ChoiceQuestion<string>,
	signal: AbortSignal,
) => Promise<ChoiceAnswer<string> | undefined>;

export async function judgeChoice<Option extends string>(
	classify: ChoiceClassifier,
	state: JudgmentState,
	question: ChoiceQuestion<Option>,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ChoiceAnswer<Option> | undefined> {
	const signal = AbortSignal.timeout(timeoutMs);
	// Bound the wait here too: a transport that ignores the signal must not hold the caller.
	const timedOut = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
	try {
		const answer = await Promise.race([classify(state, question, signal), timedOut]);
		if (!answer || !isOption(question, answer.choice)) return undefined;
		if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return undefined;
		return { choice: answer.choice, confidence: answer.confidence };
	} catch {
		return undefined;
	}
}

/** TypeSafe's System One API (Jev) over `fetch`. */
export function typesafeChoiceClassifier(apiKey: string, baseUrl = TYPESAFE_DEFAULT_BASE_URL, fetchImpl: typeof fetch = fetch): ChoiceClassifier {
	const endpoint = `${baseUrl.replace(/\/+$/u, "")}/v1/systemone`;
	return async (state, question, signal) => {
		const response = await fetchImpl(endpoint, {
			method: "POST",
			signal,
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ model: "jev-latest", state, questions: { answer: { type: "choice", ...question } } }),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		return isTypesafeChoiceBody(body) ? body.answers.answer : undefined;
	};
}

function isOption<Option extends string>(question: ChoiceQuestion<Option>, value: string): value is Option {
	return Object.hasOwn(question.criteria, value);
}

interface TypesafeChoiceBody {
	readonly answers: { readonly answer: ChoiceAnswer<string> };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- TypeSafe response boundary: the JSON body is untrusted until this predicate accepts it.
function isTypesafeChoiceBody(body: unknown): body is TypesafeChoiceBody {
	if (typeof body !== "object" || body === null || !("answers" in body)) return false;
	const answers = body.answers;
	if (typeof answers !== "object" || answers === null || !("answer" in answers)) return false;
	const answer = answers.answer;
	return typeof answer === "object" && answer !== null
		&& "choice" in answer && typeof answer.choice === "string"
		&& "confidence" in answer && typeof answer.confidence === "number" && answer.confidence >= 0 && answer.confidence <= 1;
}
