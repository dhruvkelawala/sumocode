import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [".agents/skills/verify-sumocode/scripts/drive.test.ts"],
		fileParallelism: false,
		// Three sequential 15s waits must leave time for failure capture and teardown.
		testTimeout: 90_000,
	},
});
