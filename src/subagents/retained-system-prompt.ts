import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureProcessBirthTime } from "../background-tasks/process-tree.js";
import { RETAINED_BOOTSTRAP_ENV, readBoundBootstrap, publishFactoryReceipt, type BootstrapReceiptBinding } from "./retained-bootstrap-receipt.js";

/** Source-only child entry: Pi awaits this factory before reading stdin to EOF. */
export default function installRetainedSystemPrompt(pi: ExtensionAPI): void {
	try {
		// SAFETY: readBoundBootstrap validates the entire untrusted binding and private bootstrap.
		const binding = JSON.parse(process.env[RETAINED_BOOTSTRAP_ENV] ?? "null") as BootstrapReceiptBinding;
		readBoundBootstrap(binding);
		const processStartTime = captureProcessBirthTime(process.pid);
		if (!processStartTime) return fatal();
		pi.on("before_agent_start", (event) => {
			try {
				const { systemPrompt } = readBoundBootstrap(binding);
				return { systemPrompt: systemPrompt ? `${event.systemPrompt}\n\n${systemPrompt}` : event.systemPrompt };
			} catch { return fatal(); }
		});
		publishFactoryReceipt(binding, { pid: process.pid, processStartTime });
	} catch { fatal(); }
}

function fatal(): never {
	// Pi swallows hook exceptions and print-mode shutdown is a no-op.
	try { process.stderr.write("[sumocode] retained bootstrap refused\n"); }
	finally { process.exit(1); }
}
