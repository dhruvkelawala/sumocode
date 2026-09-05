import { afterEach, expect, it, vi } from "vitest";
import { TerminalSupervisor } from "./terminal-supervisor.js";

afterEach(() => vi.useRealTimers());

it("one supervision scheduler supplies periodic fallback without notifications and tears down", () => {
	vi.useFakeTimers();
	const tick = vi.fn();
	const supervisor = new TerminalSupervisor(250, tick);
	for (let index = 0; index < 100; index += 1) supervisor.add(`term-${index}`);
	expect(vi.getTimerCount()).toBe(1);
	vi.advanceTimersByTime(500);
	expect(tick).toHaveBeenCalledTimes(2);
	expect(tick.mock.calls[0]![0]).toHaveLength(100);
	for (let index = 0; index < 99; index += 1) supervisor.delete(`term-${index}`);
	vi.advanceTimersByTime(250);
	expect(tick).toHaveBeenLastCalledWith(["term-99"]);
	supervisor.delete("term-99");
	expect(vi.getTimerCount()).toBe(0);
	supervisor.add("term-restart");
	expect(vi.getTimerCount()).toBe(1);
	supervisor.dispose();
	supervisor.add("term-after-dispose");
	vi.advanceTimersByTime(1_000);
	expect(tick).toHaveBeenCalledTimes(3);
	expect(vi.getTimerCount()).toBe(0);
});
