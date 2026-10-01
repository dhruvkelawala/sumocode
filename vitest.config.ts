import { defineConfig } from "vitest/config";
import { parseCLI } from "vitest/node";

const includeIntegration = process.argv.some((argument) => argument.includes("test/integration"));
const selectedIntegrationFile = process.env.SUMOCODE_INTEGRATION_SELECTED_FILE;
// An inherited marker must not change ordinary discovery. Parse public CLI filters
// (not option values); only one matching canonical filter needs literal inclusion
// because Vitest's positional filename matching otherwise accepts substrings.
const filters = selectedIntegrationFile ? parseCLI(["vitest", ...process.argv.slice(2)]).filter : [];
const exactIntegrationSelection = selectedIntegrationFile
	&& /^test\/integration\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.test\.ts$/.test(selectedIntegrationFile)
	&& filters.length === 1 && filters[0] === selectedIntegrationFile;

export default defineConfig({
	test: {
		include: exactIntegrationSelection ? [selectedIntegrationFile] : includeIntegration ? ["src/**/*.test.ts", "scripts/**/*.test.mjs", "test/integration/**/*.test.ts"] : ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
	},
});
