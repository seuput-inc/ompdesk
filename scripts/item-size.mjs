// Usage: node scripts/item-size.mjs <scratch-directory>. Measures synthetic JSON and warm file I/O, not the app.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (!process.argv[2]) throw new Error("Pass a scratch directory for the temporary fixture.");
const at = "2026-11-28T00:00:00.000Z";
const later = "2026-11-28T00:00:01.000Z";
const blob = value => Buffer.from(JSON.stringify(value));
let seq = 0;
const rows = Array.from({ length: 70 }, (_, i) => ({
	id: `item-${i + 1}`,
	bot: "bot-demo",
	number: i + 1,
	session: "demo.jsonl",
	title: `Item ${i + 1}`,
	status: i >= 50 ? "done" : "working",
	links: [],
	createdAt: at,
	updatedAt: at,
	touched: Date.parse(at),
	...(i >= 50 ? { closedAt: at, closed: Date.parse(at) } : {}),
	events: Array.from({ length: 17 + Number(i < 60) }, () => ({
		id: ++seq,
		at,
		actor: "bot",
		kind: "commented",
		text: "x".repeat(420),
	})),
	version: 1,
}));
assert.equal(seq, 1250);
const before = blob(rows);
const row = rows[0];
const event = {
	id: ++seq,
	at: later,
	actor: "owner",
	kind: "commented",
	text: "One comment.",
	request: "request-demo",
};
row.events.push(event);
row.updatedAt = later;
row.touched = Date.parse(later);
row.version++;
const state = { bots: [], items: rows, rooms: [], looks: [] };
const summary = r => ({
	id: r.id,
	bot: r.bot,
	number: r.number,
	session: r.session,
	title: r.title,
	status: r.status,
	updatedAt: r.updatedAt,
	version: r.version,
	lastEvent: r.events.at(-1).id,
	othersLast: r.events.findLast(e => e.actor !== "owner")?.id ?? 0,
});
const frame = r => ({
	base: "demo.1",
	version: "demo.2",
	set: { bots: [], items: [r] },
	remove: { bots: [], items: [] },
});
const dir = mkdtempSync(join(process.argv[2], "item-size-"));
try {
	const full = join(dir, "items.json");
	const tmp = join(dir, "items.tmp");
	const log = join(dir, "sample.log");
	writeFileSync(full, before);
	const old = () => {
		const disk = blob(rows);
		writeFileSync(tmp, disk);
		renameSync(tmp, full);
		return [
			disk,
			blob({ state }),
			blob(state),
			blob(frame(row)),
			blob({ version: "demo.2", state: { bots: [], items: rows } }),
		];
	};
	const sample = () => {
		const record = blob({ item: row.id, version: row.version, event });
		appendFileSync(log, record);
		return [record, blob(frame(summary(row)))];
	};
	const times = { old: [], sample: [] };
	const bytes = {};
	for (let i = 0; i < 7; i++) {
		for (const op of i % 2 ? [sample, old] : [old, sample]) {
			const start = performance.now();
			const buffers = op();
			times[op.name].push(performance.now() - start);
			bytes[op.name] = buffers.map(b => b.length);
			if (op === old) assert.equal(JSON.parse(buffers[3]).set.items[0].events.at(-1).id, event.id);
			else assert.equal(JSON.parse(buffers[1]).set.items[0].othersLast, 18);
		}
	}
	assert.deepEqual(JSON.parse(readFileSync(full))[0].events.at(-1), event);
	assert.equal(readFileSync(log).length, bytes.sample[0] * 7);
	// One heavy bot, 1,000 additional comments/day, same 420-byte body, no new items. Sum bytes, don't perform 30k writes.
	let size = bytes.old[0];
	let cumulative = 0;
	for (let i = 0; i < 30_000; i++) {
		size += blob({ ...rows[0].events[0], id: ++seq }).length + 1;
		cumulative += size;
	}
	console.log({
		before: before.length,
		bytes,
		seed: blob({ items: rows.slice(0, 50).map(summary), counts: { open: 50, closed: 20 } }).length,
		historyDelta: blob({ id: row.id, version: row.version, events: [event] }).length,
		ms: Object.fromEntries(
			Object.entries(times).map(([k, v]) => [k, v.sort((a, b) => a - b).map(n => +n.toFixed(3))]),
		),
		monthProjection: { finalPerWrite: size, cumulative },
	});
} finally {
	rmSync(dir, { recursive: true });
}
