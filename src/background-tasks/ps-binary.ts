import { isAbsolute } from "node:path";

export function resolvePsBinary(env: NodeJS.ProcessEnv = process.env): string {
	// Keep process-identity probes off PATH. The app-only sandbox supplies a
	// re-signed, non-setuid macOS ps through this explicit test override.
	const binary = env.SUMOCODE_TEST_PS_BIN ?? "/bin/ps";
	if (!isAbsolute(binary)) throw new Error("SUMOCODE_TEST_PS_BIN must be absolute");
	return binary;
}
