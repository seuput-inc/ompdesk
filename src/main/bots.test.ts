import { expect, it } from "vitest";
import { ItemFeedViewers } from "./bots";

it("only windows that explicitly read legacy state receive old bodies, until they close", async () => {
	const audience: boolean[] = [];
	const pages = new ItemFeedViewers<number>(active => audience.push(active));
	const feed = (id: number) =>
		pages.read(
			id,
			null,
			() => {},
			async () => "seed",
		);
	pages.legacyRead(1);
	await Promise.all([feed(1), feed(2)]);
	expect([1, 2, 3].map(id => pages.wantsLegacy(id))).toEqual([true, false, false]);
	pages.legacyRead(2);
	expect(pages.wantsLegacy(2)).toBe(true);
	pages.forget(2);
	await feed(2);
	expect(pages.wantsLegacy(2)).toBe(false);
	pages.forget(2);
	expect(pages.wantsLegacy(2)).toBe(false);
	expect(pages.hasLegacyReaders).toBe(true);
	pages.forget(1);
	expect(pages.hasLegacyReaders).toBe(false);
	expect(audience).toEqual([true, false]);
});
