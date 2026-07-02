import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	moduleCache: true,
	tryNative: false,
});

const mod = await jiti.import("./src/sumo-tui/rpc/host.ts");
await mod.main();
