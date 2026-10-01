import { describe, expect, it } from "vitest";
import { judgeChoice, typesafeChoiceClassifier, type ChoiceClassifier, type ChoiceQuestion } from "./judgment.js";

const question: ChoiceQuestion<"yes" | "no"> = {
	instructions: "Is `message` a greeting?",
	criteria: { yes: "A greeting", no: "Anything else" },
};

function answering(choice: string, confidence = 0.9): ChoiceClassifier {
	return async () => ({ choice, confidence });
}

describe("judgeChoice", () => {
	it("returns the classifier's choice when it is one of the question's options", async () => {
		await expect(judgeChoice(answering("yes", 0.8), { message: "hi" }, question)).resolves.toEqual({ choice: "yes", confidence: 0.8 });
	});

	it("drops a choice the question never offered", async () => {
		await expect(judgeChoice(answering("maybe"), { message: "hi" }, question)).resolves.toBeUndefined();
	});

	it("resolves undefined when the classifier fails", async () => {
		const failing: ChoiceClassifier = async () => {
			throw new Error("network down");
		};
		await expect(judgeChoice(failing, { message: "hi" }, question)).resolves.toBeUndefined();
	});

	it("gives up at the timeout instead of waiting for a slow classifier", async () => {
		const slow: ChoiceClassifier = (_state, _question, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason));
		});
		const started = Date.now();
		await expect(judgeChoice(slow, { message: "hi" }, question, 20)).resolves.toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("typesafeChoiceClassifier", () => {
	function fetchReturning(status: number, body: string, requests: Request[] = []): typeof fetch {
		return async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(body, { status });
		};
	}

	it("asks Jev one choice question and reads its answer", async () => {
		const requests: Request[] = [];
		const body = JSON.stringify({ answers: { answer: { type: "choice", choice: "yes", confidence: 0.94, probabilities: { yes: 0.97, no: 0.03 } } } });
		const classify = typesafeChoiceClassifier("ts-key", fetchReturning(200, body, requests));

		await expect(classify({ message: "hi" }, question, new AbortController().signal)).resolves.toEqual(
			expect.objectContaining({ choice: "yes", confidence: 0.94 }),
		);
		const [request] = requests;
		expect(request?.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(request?.headers.get("authorization")).toBe("Bearer ts-key");
		await expect(request?.json()).resolves.toEqual({
			model: "jev-latest",
			state: { message: "hi" },
			questions: { answer: { type: "choice", instructions: question.instructions, criteria: question.criteria } },
		});
	});

	it("returns undefined for an error status or a malformed body", async () => {
		const signal = new AbortController().signal;
		await expect(typesafeChoiceClassifier("k", fetchReturning(401, "{}"))({ message: "hi" }, question, signal)).resolves.toBeUndefined();
		await expect(typesafeChoiceClassifier("k", fetchReturning(200, '{"answers":{"answer":{"choice":3}}}'))({ message: "hi" }, question, signal)).resolves.toBeUndefined();
	});
});
