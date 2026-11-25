import { describe, expect, it } from "vitest";
import { firstUnseenRowKey, lastFinalizedRowKey, type Row } from "./chat-stream-utils";

const message = (text: string): Row => ({
	kind: "message",
	message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as never,
});

describe("the New line of a session the person comes back to", () => {
	const rows: Row[] = [{ kind: "expander", count: 3 }, message("a"), message("b"), message("c"), { kind: "pending" }];
	const keys = ["x", "a", "b", "c", "p"];

	it("marks the first row that arrived after the last one they saw", () => {
		expect(lastFinalizedRowKey(rows.slice(0, 3), keys.slice(0, 3))).toBe("b");
		expect(firstUnseenRowKey(rows, keys, "b")).toBe("c");
	});

	it("draws nothing when nothing finalized arrived, or the row they saw is gone", () => {
		expect(firstUnseenRowKey(rows, keys, "c")).toBeNull();
		expect(firstUnseenRowKey(rows, keys, "gone")).toBeNull();
		expect(firstUnseenRowKey(rows, keys, undefined)).toBeNull();
		expect(
			firstUnseenRowKey([message("a"), { kind: "streaming", message: {} as never }], ["a", "s"], "a"),
		).toBeNull();
	});

	it("never takes a live row for the last one seen", () => {
		expect(lastFinalizedRowKey(rows, keys)).toBe("c");
		expect(lastFinalizedRowKey([{ kind: "pending" }], ["p"])).toBeUndefined();
	});
});
