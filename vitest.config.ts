import { defineConfig } from "vitest/config";

const includeIntegration = process.argv.some((argument) => argument.includes("test/integration"));

export default defineConfig({
	test: {
		include: includeIntegration ? ["src/**/*.test.ts", "test/integration/**/*.test.ts"] : ["src/**/*.test.ts"],
	},
});
