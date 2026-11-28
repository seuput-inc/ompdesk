import { describe, expect, it } from "vitest";
import type { Bot, BotsState } from "../shared/bots";
import { botsStateNow, ItemFeedViewers, setBotsAsk, setBotsState } from "./bots";

const bot = (launch: string[]): Bot => ({
	id: "bot-1",
	name: "Ada",
	folder: "/bots/ada",
	home: "/s/home.jsonl",
	sessions: [],
	paused: false,
	model: null,
	autoApprove: false,
	reach: [],
	staleDays: 7,
	lookAround: null,
	tidy: null,
	quiet: [],
	createdAt: "2026-11-27T00:00:00.000Z",
	launch,
});

it("only native windows that read no legacy state opt out of old bodies, until they close", async () => {
	const pages = new ItemFeedViewers<number>();
	const feed = (id: number) =>
		pages.read(
			id,
			null,
			() => {},
			async () => "seed",
		);
	pages.legacyRead(1);
	await Promise.all([feed(1), feed(2)]);
	expect([1, 2, 3].map(id => pages.wantsLegacy(id))).toEqual([true, false, true]);
	pages.legacyRead(2);
	expect(pages.wantsLegacy(2)).toBe(true);
	pages.forget(2);
	await feed(2);
	expect(pages.wantsLegacy(2)).toBe(false);
	pages.forget(2);
	expect(pages.wantsLegacy(2)).toBe(true);
});

describe("botsStateNow", () => {
	it("asks the core once before any tell, so a bot chat restored at launch spawns with its owner's flags", async () => {
		let asked = 0;
		setBotsAsk(async (): Promise<BotsState> => {
			asked += 1;
			return { bots: [bot(["--approval-mode", "always-ask"])], items: [] };
		});
		const first = await botsStateNow();
		expect(first.bots.find(entry => entry.folder === "/bots/ada")?.launch).toEqual(["--approval-mode", "always-ask"]);
		await botsStateNow();
		expect(asked).toBe(1);
		// A later tell is what the next spawn reads.
		setBotsState({ bots: [bot([])], items: [] });
		expect((await botsStateNow()).bots[0]?.launch).toEqual([]);
		expect(asked).toBe(1);
	});
});
