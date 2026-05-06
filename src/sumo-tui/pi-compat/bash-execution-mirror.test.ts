import { describe, expect, it, vi } from "vitest";
import { loadYoga } from "../layout/yoga.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { BashExecutionMirror, isBashExecutionLike, renderBashMirrorText, type BashExecutionLike } from "./bash-execution-mirror.js";

interface FakeBashOptions {
	readonly command?: string;
}

class FakeBashComponent implements BashExecutionLike {
	private command: string;
	private outputChunks: string[] = [];
	private complete = false;
	private exitCode: number | undefined;
	private cancelled = false;
	private fullOutputPath: string | undefined;

	public constructor(options: FakeBashOptions = {}) {
		this.command = options.command ?? "echo hi";
	}

	public render(_width: number): string[] {
		return [this.command];
	}

	public invalidate(): void {}

	public getCommand(): string {
		return this.command;
	}

	public getOutput(): string {
		return this.outputChunks.join("");
	}

	public appendOutput(chunk: string): void {
		this.outputChunks.push(chunk);
	}

	public setComplete(exitCode?: number, cancelled?: boolean, _truncationResult?: unknown, fullOutputPath?: string): void {
		this.complete = true;
		this.exitCode = exitCode;
		this.cancelled = cancelled === true;
		this.fullOutputPath = fullOutputPath;
	}

	public isComplete(): boolean {
		return this.complete;
	}

	public getExitCode(): number | undefined {
		return this.exitCode;
	}

	public wasCancelled(): boolean {
		return this.cancelled;
	}

	public getFullOutputPath(): string | undefined {
		return this.fullOutputPath;
	}
}

async function buildPager(): Promise<ChatPager> {
	const yoga = await loadYoga();
	return ChatPager.create(yoga);
}

describe("isBashExecutionLike", () => {
	it("accepts components with the bash-execution shape", () => {
		expect(isBashExecutionLike(new FakeBashComponent())).toBe(true);
	});

	it("rejects values without the required methods", () => {
		expect(isBashExecutionLike(undefined)).toBe(false);
		expect(isBashExecutionLike(null)).toBe(false);
		expect(isBashExecutionLike({})).toBe(false);
		expect(isBashExecutionLike({
			render: (_w: number) => [""],
			getCommand: () => "ls",
		})).toBe(false);
	});
});

describe("renderBashMirrorText", () => {
	it("renders running state with command and partial output", () => {
		const fake = new FakeBashComponent({ command: "ls" });
		fake.appendOutput("a\nb\n");
		expect(renderBashMirrorText(fake, undefined)).toBe("$ ls\n\na\nb\n\nrunning…");
	});

	it("omits running marker on successful completion", () => {
		const fake = new FakeBashComponent({ command: "true" });
		fake.appendOutput("ok\n");
		const completion = { exitCode: 0, cancelled: false, truncationResult: undefined, fullOutputPath: undefined };
		expect(renderBashMirrorText(fake, completion)).toBe("$ true\n\nok");
	});

	it("annotates non-zero exit codes", () => {
		const fake = new FakeBashComponent({ command: "false" });
		const completion = { exitCode: 1, cancelled: false, truncationResult: undefined, fullOutputPath: undefined };
		expect(renderBashMirrorText(fake, completion)).toBe("$ false\n\nexit 1");
	});

	it("annotates cancelled commands", () => {
		const fake = new FakeBashComponent({ command: "sleep 5" });
		const completion = { exitCode: undefined, cancelled: true, truncationResult: undefined, fullOutputPath: undefined };
		expect(renderBashMirrorText(fake, completion)).toBe("$ sleep 5\n\ncancelled");
	});

	it("includes truncation pointer when full output path is provided", () => {
		const fake = new FakeBashComponent({ command: "yes" });
		fake.appendOutput("y\n");
		const completion = { exitCode: 0, cancelled: false, truncationResult: { truncated: true }, fullOutputPath: "/tmp/full.log" };
		expect(renderBashMirrorText(fake, completion)).toBe("$ yes\n\ny\n\noutput truncated → /tmp/full.log");
	});
});

describe("BashExecutionMirror", () => {
	it("attaches a chat message and updates on streaming output", async () => {
		const chat = await buildPager();
		const requestRender = vi.fn();
		const markRenderDirty = vi.fn();
		const mirror = new BashExecutionMirror(chat, { requestRender, markRenderDirty });
		const fake = new FakeBashComponent({ command: "echo hi" });

		expect(mirror.attach(fake)).toBe(true);
		expect(chat.getRenderedMessages().length).toBe(1);
		expect(chat.getLastMessage()?.text).toBe("$ echo hi\n\nrunning…");
		expect(requestRender).toHaveBeenCalledTimes(1);

		fake.appendOutput("hello\n");
		expect(chat.getLastMessage()?.text).toBe("$ echo hi\n\nhello\n\nrunning…");
		expect(requestRender).toHaveBeenCalledTimes(2);
		expect(markRenderDirty).toHaveBeenCalledTimes(2);
	});

	it("renders completion state with exit code and clears running marker", async () => {
		const chat = await buildPager();
		const requestRender = vi.fn();
		const mirror = new BashExecutionMirror(chat, { requestRender });
		const fake = new FakeBashComponent({ command: "false" });

		mirror.attach(fake);
		fake.setComplete(1, false);
		expect(chat.getLastMessage()?.text).toBe("$ false\n\nexit 1");
		expect(fake.isComplete()).toBe(true);
		expect(fake.getExitCode()).toBe(1);
	});

	it("does not double-mirror the same component", async () => {
		const chat = await buildPager();
		const mirror = new BashExecutionMirror(chat, { requestRender: () => {} });
		const fake = new FakeBashComponent();

		expect(mirror.attach(fake)).toBe(true);
		expect(mirror.attach(fake)).toBe(false);
		expect(chat.getRenderedMessages().length).toBe(1);
	});

	it("ignores non-bash components", async () => {
		const chat = await buildPager();
		const mirror = new BashExecutionMirror(chat, { requestRender: () => {} });
		expect(mirror.attach({})).toBe(false);
		expect(mirror.attach(undefined)).toBe(false);
		expect(chat.getRenderedMessages().length).toBe(0);
	});

	it("preserves Pi's original methods", async () => {
		const chat = await buildPager();
		const mirror = new BashExecutionMirror(chat, { requestRender: () => {} });
		const fake = new FakeBashComponent({ command: "sleep 0" });

		mirror.attach(fake);
		fake.appendOutput("data");
		expect(fake.getOutput()).toBe("data");
		fake.setComplete(0, false);
		expect(fake.isComplete()).toBe(true);
		expect(fake.getExitCode()).toBe(0);
	});
});
