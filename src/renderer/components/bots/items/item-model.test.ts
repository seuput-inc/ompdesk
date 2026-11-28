import { describe, expect, it } from "vitest";
import type { Item, ItemEvent } from "../../../../shared/bots";
import { answersText, groupItems, isUnseen, snoozePresets, stepFrom, walkOrder } from "./item-model";

const NOW = new Date(2026, 10, 25, 10, 30).getTime(); // a Wednesday, 10:30 local

function event(id: number, actor: ItemEvent["actor"], kind: ItemEvent["kind"] = "commented"): ItemEvent {
	return { id, at: new Date(NOW - 60_000).toISOString(), actor, kind };
}

function item(number: number, patch: Partial<Item> = {}): Item {
	return {
		id: `i${number}`,
		bot: "b",
		number,
		session: "/s.jsonl",
		title: `Item ${number}`,
		status: "planned",
		links: [],
		createdAt: new Date(NOW - 3_600_000).toISOString(),
		updatedAt: new Date(NOW - 3_600_000).toISOString(),
		events: [],
		version: 1,
		...patch,
	};
}

describe("groupItems", () => {
	it("files snoozed and stale items apart, closed last, and puts unseen first within a group", () => {
		const later = new Date(NOW + 3_600_000).toISOString();
		const groups = groupItems(
			[
				item(1, { status: "working", updatedAt: new Date(NOW - 1_000).toISOString() }),
				item(2, { status: "working", events: [event(7, "bot")] }),
				item(3, { status: "planned", snoozedUntil: later }),
				item(4, { status: "planned", stale: true }),
				item(5, { status: "done", snoozedUntil: later }),
				item(6, { status: "needs_you" }),
			],
			() => 5,
			NOW,
		);
		expect(groups.working.map(entry => entry.number)).toEqual([2, 1]);
		expect(groups.snoozed.map(entry => entry.number)).toEqual([3]);
		expect(groups.stale.map(entry => entry.number)).toEqual([4]);
		// A closed item is never snoozed, whatever its wake time says.
		expect(groups.closed.map(entry => entry.number)).toEqual([5]);
		expect(walkOrder(groups)).toEqual(["i6", "i2", "i1", "i3", "i4", "i5"]);
	});
});

describe("isUnseen", () => {
	it("uses the summary's non-owner watermark independently of its most recent event", () => {
		const { events: _events, links: _links, ...fields } = item(2);
		const row = { ...fields, askedAt: null, sessionLinks: [], touched: NOW, othersLast: 4, lastEvent: 30 };
		expect(isUnseen(row, 4)).toBe(false);
		expect(isUnseen(row, 3)).toBe(true);
	});

	it("counts only what someone but the owner did after the mark", () => {
		expect(isUnseen(item(1, { events: [event(9, "owner")] }), 5)).toBe(false);
		expect(isUnseen(item(1, { events: [event(4, "bot"), event(9, "owner")] }), 5)).toBe(false);
		expect(isUnseen(item(1, { events: [event(6, "bot")] }), 5)).toBe(true);
	});
});

describe("stepFrom", () => {
	it("stops at either end and at an item no longer listed", () => {
		const order = ["a", "b", "c"];
		expect(stepFrom(order, "b", 1)).toBe("c");
		expect(stepFrom(order, "a", -1)).toBeNull();
		expect(stepFrom(order, "c", 1)).toBeNull();
		expect(stepFrom(order, "gone", 1)).toBeNull();
	});
});

describe("answersText", () => {
	it("sends several answers as one line per answered question, in the ask's order", () => {
		const question = {
			id: 3,
			text: "Two things",
			options: [],
			decisions: [
				{ question: "**Which** region?", options: ["eu", "us"] },
				{ question: "Ship today?", options: [] },
				{ question: "Notify whom?", options: [] },
			],
		};
		expect(answersText(question, ["eu", null, " the team "])).toBe("Which region? → eu\nNotify whom? → the team");
		expect(answersText(question, [null, " ", null])).toBeNull();
	});

	it("sends one question's answer as it is", () => {
		expect(answersText({ id: 1, text: "Go?", options: ["yes", "no"] }, ["yes"])).toBe("yes");
	});
});

describe("snoozePresets", () => {
	it("reads this device's clock: this evening, tomorrow 9 AM, next Monday 9 AM, and In a week in the picker", () => {
		const [later, tomorrow, monday, week] = snoozePresets(NOW, true);
		expect(new Date(later.at).getHours()).toBe(18);
		expect(new Date(tomorrow.at).getDate()).toBe(26);
		expect(new Date(monday.at).getDay()).toBe(1);
		expect(new Date(monday.at).getDate()).toBe(30);
		expect(new Date(week.at).getDate()).toBe(2);
	});

	it("after 5 PM, Later today is three hours out, rounded up to the hour", () => {
		const evening = new Date(2026, 10, 25, 17, 20).getTime();
		const [later] = snoozePresets(evening);
		expect(later.inHours).toBe(3);
		expect(new Date(later.at).getHours()).toBe(21);
	});

	it("on a Monday, next Monday and In a week are one preset", () => {
		const monday = new Date(2026, 10, 30, 10).getTime();
		expect(snoozePresets(monday, true).map(preset => preset.id)).toEqual(["later", "tomorrow", "week"]);
	});
});
