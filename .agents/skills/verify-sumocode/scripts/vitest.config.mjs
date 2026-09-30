import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [".agents/skills/verify-sumocode/scripts/drive.test.ts"],
		fileParallelism: false,
		testTimeout: 30_000,
	},
});
