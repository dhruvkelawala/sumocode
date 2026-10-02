import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openWebLink } from "./open-web-link.js";

const launch = vi.fn((_command: string, _args: readonly string[], _options: { detached: true; stdio: "ignore" }) => {
	const child = new ChildProcess();
	queueMicrotask(() => child.emit("spawn"));
	return child;
});
beforeEach(() => { launch.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("openWebLink", () => {
	it("passes the complete URL as one argument without a shell or inherited pipes", async () => {
		const url = `https://claude.com/cai/auth/authorize?state=${"x".repeat(180)}&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback&literal=$(echo_test)`;
		expect(await openWebLink(url, launch)).toBe(true);
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
		const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
		expect(launch).toHaveBeenCalledExactlyOnceWith(command, args, { detached: true, stdio: "ignore" });
	});

	it.each(["not a URL", "javascript:alert(1)", "file:///tmp/test", "data:text/html,test", "https://example.com/\nsecret", "https://example.com/\x1b[0m"])("refuses unsafe target %j before spawning", async (url) => {
		expect(await openWebLink(url, launch)).toBe(false);
		expect(launch).not.toHaveBeenCalled();
	});

	it("dispatches the complete Windows query through the URL protocol handler", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		const url = "https://example.com/authorize?state=a=b&comma=a,b&literal=$(echo_test)";
		const opened = openWebLink(url, launch);
		const child = launch.mock.results[0].value;
		const unref = vi.spyOn(child, "unref");
		expect(await opened).toBe(true);
		expect(launch).toHaveBeenCalledExactlyOnceWith("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" });
		expect(unref).toHaveBeenCalledOnce();
	});

	it.each(["ENOENT", "EACCES"])("contains launcher startup failure %s", async (code) => {
		launch.mockImplementationOnce(() => {
			const child = new ChildProcess();
			queueMicrotask(() => child.emit("error", Object.assign(new Error("opener unavailable"), { code })));
			return child;
		});
		expect(await openWebLink("https://example.com", launch)).toBe(false);
	});

	it("contains synchronous launcher failures", async () => {
		launch.mockImplementationOnce(() => { throw new Error("opener unavailable"); });
		expect(await openWebLink("https://example.com", launch)).toBe(false);
	});

	it("returns while a real launcher is still running instead of waiting for or killing it", async () => {
		let child: ChildProcess | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const opened = openWebLink("https://example.com", (_command, _args, options) => {
				child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], options);
				return child;
			});
			const deadline = new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 1000); });
			expect(await Promise.race([opened, deadline])).toBe(true);
			expect(child!.exitCode).toBeNull();
			expect(child!.killed).toBe(false);
		} finally {
			clearTimeout(timeout);
			if (child) {
				const closed = once(child, "close");
				child.kill("SIGTERM");
				await closed;
			}
		}
	});
});
