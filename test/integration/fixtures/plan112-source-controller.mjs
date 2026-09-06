import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

process.umask(0o077);
const [root, mode, pi, provider] = process.argv.slice(2);
// Stay alive for birth capture even if source loading or the scenario fails.
setInterval(() => {}, 60_000);
const deadline = Date.now() + 10_000;
while (!existsSync(join(root, `admit-${process.pid}`))) {
	if (Date.now() >= deadline) throw new Error("controller birth admission timeout");
	await new Promise((resolve) => setTimeout(resolve, 10));
}
try {
	const jiti = createJiti(import.meta.url, { tryNative: false, fsCache: false });
	const { runSourceController } = await jiti.import("./plan112-source-controller.ts");
	await runSourceController(root, mode, pi, provider);
} catch (error) {
	writeFileSync(join(root, `${mode}-error.pending`), JSON.stringify({ error: error instanceof Error ? error.message : "source controller failed" }), { mode: 0o600 });
	renameSync(join(root, `${mode}-error.pending`), join(root, `${mode}-error.json`));
}
