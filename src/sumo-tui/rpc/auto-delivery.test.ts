import { describe, expect, it, vi } from "vitest";
import type { ChoiceClassifier } from "../../judgment.js";
import { createJevDeliveryDecider } from "./auto-delivery.js";

function jevAnswering(choice: string, confidence: number): ReturnType<typeof vi.fn<ChoiceClassifier>> {
	return vi.fn<ChoiceClassifier>(async () => ({ choice, confidence }));
}

describe("createJevDeliveryDecider", () => {
	it("follows up only when Jev is confident; anything else steers", async () => {
		await expect(createJevDeliveryDecider(jevAnswering("follow_up", 0.92))("after that, look at issue 412", "refactor")).resolves.toBe("followUp");
		await expect(createJevDeliveryDecider(jevAnswering("follow_up", 0.3))("then open a PR", "refactor")).resolves.toBe("steer");
		await expect(createJevDeliveryDecider(jevAnswering("steer", 0.99))("don't touch host.ts", "refactor")).resolves.toBe("steer");
		await expect(createJevDeliveryDecider(async () => undefined)("anything", undefined)).resolves.toBe("steer");
	});

	it("sends the run's prompt as context when it is known", async () => {
		const classify = jevAnswering("steer", 1);
		await createJevDeliveryDecider(classify)("use a Map", "refactor the scheduler");
		await createJevDeliveryDecider(classify)("use a Map", undefined);
		expect(classify.mock.calls.map(([state]) => state)).toEqual([
			{ current_task: "refactor the scheduler", message: "use a Map" },
			{ message: "use a Map" },
		]);
	});
});
