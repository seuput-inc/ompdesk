import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingToolCalls, replayOfEarlierLife } from "../../resources/gui-bridge/quit-journal-core";

afterEach(() => {
	vi.useRealTimers();
});

describe("the tool calls a quit waits for", () => {
	it("lets a quit with nothing running go at once", async () => {
		expect(await createPendingToolCalls().settled(1_000)).toBe(true);
	});

	it("holds the quit until every started call has its result, however they finish", async () => {
		const calls = createPendingToolCalls();
		calls.start("a");
		calls.start("b");
		let outcome: boolean | undefined;
		void calls.settled(1_000).then(value => {
			outcome = value;
		});
		calls.settle("b");
		await Promise.resolve();
		expect(outcome).toBeUndefined();
		calls.settle("a");
		await vi.waitFor(() => expect(outcome).toBe(true));
	});

	it("gives up after the bound when a tool never returns, and says so", async () => {
		vi.useFakeTimers();
		const calls = createPendingToolCalls();
		calls.start("stuck");
		const waiting = calls.settled(1_500);
		await vi.advanceTimersByTimeAsync(1_499);
		let done = false;
		void waiting.then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await waiting).toBe(false);
	});

	it("does not count a result for a call it never saw", async () => {
		const calls = createPendingToolCalls();
		calls.start("a");
		calls.settle("other");
		expect(calls.size).toBe(1);
	});
});

describe("a command stock's replay would run a second time", () => {
	const started = Date.parse("2026-11-20T10:00:00.000Z");
	const before = "2026-11-20T09:59:00.000Z";
	const after = "2026-11-20T10:00:05.000Z";
	const call = (timestamp: string) => ({
		type: "message",
		id: "a1",
		timestamp,
		message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash" }] },
	});
	const result = (text: string, timestamp: string) => ({
		type: "message",
		id: "r1",
		timestamp,
		message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text }] },
	});
	const claim = { type: "custom", id: "c1", timestamp: after };

	it("is refused with what the earlier process returned, past the entries other hooks journal", () => {
		const anchor = call(before);
		const entries = [anchor, result("[main 1a2b3c] chore: empty\n\nCommand aborted", before), claim];
		expect(replayOfEarlierLife(entries, [anchor, claim], "call_1", started)).toEqual({
			earlier: "[main 1a2b3c] chore: empty\n\nCommand aborted",
		});
	});

	it("is refused without an earlier result when the process died while it ran", () => {
		const anchor = call(before);
		const unknown = result("Previous OMP process exited before this tool returned; its outcome is unknown.", after);
		expect(replayOfEarlierLife([anchor, unknown], [anchor], "call_1", started)).toEqual({});
	});

	it("runs when this process journaled the call: a person's own retry", () => {
		const anchor = call(after);
		expect(replayOfEarlierLife([anchor], [anchor], "call_1", started)).toBeUndefined();
	});

	it("runs a new call while an earlier result is the branch's last message", () => {
		const done = result("ok", before);
		expect(replayOfEarlierLife([call(before), done], [call(before), done], "call_1", started)).toBeUndefined();
	});
});
