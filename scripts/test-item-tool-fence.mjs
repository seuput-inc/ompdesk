import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { installItemToolFence, ItemToolFence, WORKER_ENTRY } from "../resources/gui-bridge/item-work.ts";

const proof = "synthetic-core";
const descriptor = JSON.stringify({
	item: "item-a",
	generation: 3,
	core: createHash("sha256").update(proof).digest("hex"),
});

test("only the attached core can grant this tool call; disconnect and a late answer do not renew it", async () => {
	let request;
	const link = {
		write(line) {
			const { event } = JSON.parse(line);
			assert.equal(event.item, "item-a");
			assert.equal(event.generation, 3);
			assert.equal(event.session, "/synthetic/a.jsonl");
			request = event.request;
		},
	};
	const other = {
		write() {
			assert.fail("no check goes to this socket");
		},
	};
	const fence = new ItemToolFence(descriptor);
	const check = () => fence.check("/synthetic/a.jsonl");
	assert.equal(await check(), false);
	assert.equal(fence.attach(other, "not-core"), false);
	assert.equal(fence.attach(link, proof), true);
	assert.equal(await fence.check(undefined), false);
	const first = check();
	assert.equal(fence.answer(other, { request, validMs: 2000 }), false);
	assert.equal(fence.answer(link, { request, validMs: 2000 }), true);
	assert.equal(await first, true);
	const second = check();
	fence.disconnect(link);
	assert.equal(await second, false);
	assert.equal(fence.attach(link, proof), true);
	assert.equal(fence.answer(link, { request, validMs: 2000 }), false);
	const expired = check();
	const clock = mock.method(performance, "now", () => Number.MAX_SAFE_INTEGER);
	try {
		fence.answer(link, { request, validMs: 2000 });
		assert.equal(await expired, false);
	} finally {
		clock.mock.restore();
	}
	assert.equal(new ItemToolFence("invalid").attach(link, proof), false);
});

test("ordinary tools run unchanged; a resumed managed journal without its owner refuses tools", async () => {
	const handlers = new Map();
	const api = { on: (event, fn) => handlers.set(event, fn) };
	const call = data =>
		handlers.get("tool_call")({}, {
			sessionManager: {
				getSessionFile: () => "/synthetic/a.jsonl",
				getEntries: () => [{ type: "custom", customType: WORKER_ENTRY, data }],
			},
		});
	installItemToolFence(api, undefined);
	assert.equal(await call({ from: "ordinary opener" }), undefined);
	handlers.get("session_switch")();
	assert.equal((await call({ managed: true })).block, true);
	handlers.get("session_start")();
	assert.equal(await call({}), undefined);
	installItemToolFence(api, new ItemToolFence(descriptor));
	assert.equal((await call({})).block, true);
});
