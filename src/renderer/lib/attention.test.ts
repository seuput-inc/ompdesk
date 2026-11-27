import { describe, expect, it } from "vitest";
import { boardCounts } from "../components/layout/work-board/work-board";
import { type AttentionState, sessionAttention } from "./attention";

const none: AttentionState = { asks: [], childrenWaiting: 0 };

describe("sessionAttention", () => {
	it("is null when nothing needs the person", () => {
		expect(sessionAttention(none)).toBeNull();
	});

	it("names each kind on its own", () => {
		expect(sessionAttention({ ...none, asks: ["question"] })).toEqual({ kind: "question", count: 1 });
		expect(sessionAttention({ ...none, asks: ["approval"] })).toEqual({ kind: "approval", count: 1 });
		expect(sessionAttention({ ...none, childrenWaiting: 2 })).toEqual({ kind: "childWaiting", count: 2 });
	});

	it("says the session's first prompt before a waiting child", () => {
		expect(sessionAttention({ asks: ["approval", "question"], childrenWaiting: 1 })?.kind).toBe("approval");
		expect(sessionAttention({ asks: ["question", "approval"], childrenWaiting: 0 })?.kind).toBe("question");
		expect(sessionAttention({ asks: [], childrenWaiting: 1 })?.kind).toBe("childWaiting");
	});

	it("counts what the board's Needs you counts", () => {
		const cases: AttentionState[] = [
			none,
			{ asks: ["question"], childrenWaiting: 0 },
			{ asks: ["approval", "question"], childrenWaiting: 3 },
		];
		for (const state of cases) {
			const counts = boardCounts({
				asks: state.asks,
				childrenWaiting: state.childrenWaiting,
				childrenRunning: 2,
				agents: 1,
				agentsWorking: 1,
				jobs: 0,
				turnWorking: true,
			});
			expect(sessionAttention(state)?.count ?? 0).toBe(counts.needs);
		}
	});
});
