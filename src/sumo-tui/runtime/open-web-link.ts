import { spawn, type ChildProcess } from "node:child_process";

/** Launch web links without accepting executable schemes or shell input. */
export async function openWebLink(
	url: string,
	launch: (command: string, args: readonly string[], options: { detached: true; stdio: "ignore" }) => ChildProcess = spawn,
): Promise<boolean> {
	try {
		// oxlint-disable-next-line no-control-regex -- untrusted hyperlink metadata must not contain terminal/control bytes.
		if (/[\x00-\x1f\x7f]/.test(url)) return false;
		const protocol = new URL(url).protocol;
		if (protocol !== "https:" && protocol !== "http:") return false;
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
		// Match Pi's URL handler: Explorer splits unquoted '=' and ',' fields.
		const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
		const child = launch(command, args, { detached: true, stdio: "ignore" });
		// Browser launchers can outlive the handoff.
		// Report dispatch, not browser lifetime; never kill a launched browser.
		return await new Promise<boolean>((resolve) => {
			child.once("error", () => resolve(false));
			child.once("spawn", () => {
				child.unref();
				resolve(true);
			});
		});
	} catch {
		return false;
	}
}
