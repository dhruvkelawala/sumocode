import { defineConfig } from "vitest/config";

const includeIntegration = process.argv.some((argument) => argument.includes("test/integration"));
// The canonical harness validates this literal path and clears ambient selection
// for default/native/seam lanes. Vitest's positional CLI filters are substrings.
const selectedIntegrationFile = process.env.SUMOCODE_INTEGRATION_SELECTED_FILE;

export default defineConfig({
	test: {
		include: selectedIntegrationFile ? [selectedIntegrationFile] : includeIntegration ? ["src/**/*.test.ts", "scripts/**/*.test.mjs", "test/integration/**/*.test.ts"] : ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
	},
});
