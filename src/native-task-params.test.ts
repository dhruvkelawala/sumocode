import { describe, expect, it } from "vitest";
import { normalizeTaskParams } from "./native-task-params.js";

describe("native task params", () => {
	it("normalizes single task defaults", () => {
		const result = normalizeTaskParams({ type: "single", tasks: [{ prompt: "Audit auth" }] });

		expect(result).toEqual({
			ok: true,
			value: {
				mode: "single",
				model: undefined,
				thinking: "inherit",
				items: [{ prompt: "Audit auth", skill: undefined, model: undefined, thinking: undefined, fork: true }],
			},
		});
	});

	it("rejects invalid thinking levels", () => {
		const result = normalizeTaskParams({ type: "single", tasks: [{ prompt: "Audit auth", thinking: "maximum" }] });

		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.error).toContain("thinking");
	});
});
