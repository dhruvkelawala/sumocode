// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- focused extension-event test doubles intentionally model only the session_start seam.
import { describe, expect, it, vi } from "vitest";
import installPiChildModelBootstrap, { CHILD_MODEL_ID_ENV, CHILD_MODEL_PROVIDER_ENV } from "./pi-child-model-bootstrap.js";

describe("Pi child model bootstrap", () => {
	it("selects a numbered provider after session-start registration", async () => {
		const setModel = vi.fn(async () => true);
		let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			}),
			setModel,
		};
		installPiChildModelBootstrap(pi as never);
		const model = { provider: "anthropic-2", id: "claude-haiku-4-5" };
		const previousProvider = process.env[CHILD_MODEL_PROVIDER_ENV];
		const previousModel = process.env[CHILD_MODEL_ID_ENV];
		process.env[CHILD_MODEL_PROVIDER_ENV] = model.provider;
		process.env[CHILD_MODEL_ID_ENV] = model.id;
		try {
			if (!sessionStart) throw new Error("session_start handler was not registered");
			await sessionStart({}, { modelRegistry: { find: vi.fn(() => model) } });
			expect(setModel).toHaveBeenCalledWith(model);
		} finally {
			if (previousProvider === undefined) delete process.env[CHILD_MODEL_PROVIDER_ENV];
			else process.env[CHILD_MODEL_PROVIDER_ENV] = previousProvider;
			if (previousModel === undefined) delete process.env[CHILD_MODEL_ID_ENV];
			else process.env[CHILD_MODEL_ID_ENV] = previousModel;
		}
	});

	it.each([
		["missing provider model", undefined, true],
		["unavailable authentication", { provider: "anthropic-2", id: "claude-haiku-4-5" }, false],
	] as const)("terminates before prompting when selection fails: %s", async (_label, model, setModelResult) => {
		const setModel = vi.fn(async () => setModelResult);
		let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			}),
			setModel,
		};
		const termination = new Error("child terminated");
		const terminate = vi.fn((_message: string): never => { throw termination; });
		installPiChildModelBootstrap(pi as never, terminate);
		const previousProvider = process.env[CHILD_MODEL_PROVIDER_ENV];
		const previousModel = process.env[CHILD_MODEL_ID_ENV];
		process.env[CHILD_MODEL_PROVIDER_ENV] = "anthropic-2";
		process.env[CHILD_MODEL_ID_ENV] = "claude-haiku-4-5";
		try {
			if (!sessionStart) throw new Error("session_start handler was not registered");
			await expect(sessionStart({}, { modelRegistry: { find: vi.fn(() => model) } })).rejects.toBe(termination);
			expect(terminate).toHaveBeenCalledOnce();
			if (!model) expect(setModel).not.toHaveBeenCalled();
		} finally {
			if (previousProvider === undefined) delete process.env[CHILD_MODEL_PROVIDER_ENV];
			else process.env[CHILD_MODEL_PROVIDER_ENV] = previousProvider;
			if (previousModel === undefined) delete process.env[CHILD_MODEL_ID_ENV];
			else process.env[CHILD_MODEL_ID_ENV] = previousModel;
		}
	});
});
