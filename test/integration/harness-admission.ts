import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Hold a trusted bootstrap until the parent has registered its birth. */
export function prepareHarnessAdmission(command: string, args: readonly string[], evidenceDir: string) {
	// Darwin limits Unix socket addresses to 104 bytes; private test TMPDIRs exceed that.
	const directory = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "sumo-admit-"));
	const address = join(directory, "socket");
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	let grant = "";
	const server = createServer((connection) => {
		connection.on("error", () => {});
		connection.end(grant);
		server.close();
	});
	server.on("close", () => {
		try { rmdirSync(directory); } catch { /* Preserve a nonempty directory for inspection. */ }
	});
	server.on("error", () => { server.close(); });
	writeFileSync(join(evidenceDir, "admission.json"), `${JSON.stringify({ directory })}\n`, { mode: 0o600 });
	server.listen(address);
	server.unref();
	return {
		command: process.execPath,
		args: [fileURLToPath(new URL("./fixtures/harness-admission.cjs", import.meta.url)), address,
			publicKey.export({ type: "spki", format: "der" }).toString("base64"), command, ...args],
		// A same-user child can replace the socket path, but cannot forge this grant.
		release(pid: number): void { grant = sign(null, Buffer.from(String(pid)), privateKey).toString("base64"); },
		cancel(): void { server.close(); },
	};
}
