import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const target = "item-000001";
export const comment = { action: "item", id: target, requestId: "request-0001", comment: "One comment." };
export const feed = { protocol: 2, action: "itemsFeed" };
export const detail = { protocol: 2, action: "itemDetail", bot: "bot-demo", id: target };
const at = new Date().toISOString(); // Closed rows must be inside v1's rolling seven-day window.

export function fixture(dir, scale) {
	const chat = "/synthetic/chat.jsonl";
	const n = scale === "unrelated-x10" ? 691 : 70;
	let seq = 100_000;
	const rows = Array.from({ length: n }, (_, i) => {
		const source = i ? 1 + ((i - 1) % 69) : 0;
		const closed = source >= 50;
		const history = (17 + Number(source < 60)) * (i === 0 && scale === "history-x10" ? 10 : 1);
		return {
			id: `item-${String(i + 1).padStart(6, "0")}`,
			bot: "bot-demo",
			number: 1000 + i,
			session: chat,
			title: `Subject ${String(i).padStart(4, "0")}`,
			status: closed ? "done" : "working",
			links: [],
			createdAt: at,
			updatedAt: at,
			touched: Date.parse(at),
			version: 10,
			...(closed ? { closedAt: at, closed: Date.parse(at) } : {}),
			events: Array.from({ length: history }, () => ({
				id: ++seq,
				at,
				actor: "bot",
				kind: "commented",
				text: "x".repeat(420),
			})),
		};
	});
	assert.equal(seq - 100_000, { base: 1250, "unrelated-x10": 18 + 1232 * 10, "history-x10": 1250 + 162 }[scale]);
	// One setup-only status change restores this event count and warms the actual bot digest before measurement.
	rows[1].events.pop();
	rows[1].status = "planned";
	const files = {
		items: join(dir, "items.json"),
		bots: join(dir, "bots.json"),
		mailOutbox: { file: join(dir, "mail-outbox.json") },
	};
	writeFileSync(files.items, JSON.stringify(rows));
	writeFileSync(
		files.bots,
		JSON.stringify([{ id: "bot-demo", name: "Demo", folder: dir, home: chat, sessions: [chat], createdAt: at }]),
	);
	return {
		files,
		state: {
			enabled: true,
			tabs: [{ tabId: "demo0001", cwd: dir, title: "Demo", sessionPath: chat, status: "ready" }],
		},
		items: n,
		open: rows.filter(r => !r.closed).length,
		events: seq - 100_000,
		cursor: rows[0].events.at(-1).id,
	};
}
