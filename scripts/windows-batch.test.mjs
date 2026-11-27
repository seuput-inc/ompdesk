import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { requestOnce } from "./dev-release.mjs";
import { selectWindowsBatch } from "./windows-batch.mjs";

const base = "1".repeat(40);
const first = "9641c50bcdce706d2c0fe224a2d72fa3c26bd17f";
const second = "b".repeat(40);
const third = "c".repeat(40);
const completed = conclusion => ({ status: "completed", conclusion });

function publisher() {
	const home = mkdtempSync(join(tmpdir(), "windows-batch-"));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const dir = join(home, "windows");
	const receipts = new Map();
	const requests = [];
	const commits = [base, first, second, third];
	const select = (tip, published = base) =>
		selectWindowsBatch({
			dir,
			base: published,
			tip,
			contains: sha => commits.slice(commits.indexOf(published) + 1, commits.indexOf(tip) + 1).includes(sha),
			receipt: sha => receipts.get(sha),
		});
	const request = (batch, send = sha => requests.push(sha)) => {
		if (batch.claim()) requestOnce(join(dir, "requests"), batch.candidate, send);
	};
	return { dir, receipts, requests, select, request };
}

test("moving dev while Windows runs sends no further requests, even after the old candidate passes", () => {
	const { select, request, receipts, requests } = publisher();
	request(select(first));
	for (const run of [
		{ status: "in_progress", conclusion: null },
		completed("success"),
		completed("skipped"),
		completed(null),
		{ status: "queued", conclusion: "failure" },
		undefined,
	]) {
		receipts.set(first, run);
		const batch = select(second);
		assert.equal(batch.candidate, first);
		request(batch);
	}
	assert.deepEqual(requests, [first]);
});

for (const conclusion of ["failure", "cancelled"]) {
	test(`completed ${conclusion} allows a changed descendant only`, () => {
		const { select, request, receipts, requests } = publisher();
		request(select(first));
		receipts.set(first, completed(conclusion));
		request(select(first));
		const replacement = select(second);
		assert.equal(replacement.candidate, second);
		request(replacement);
		request(select(third));
		assert.deepEqual(requests, [first, second]);
	});
}

test("a receipt that becomes uncertain before dispatch does not replace the pin", () => {
	const { select, request, receipts, requests } = publisher();
	request(select(first));
	receipts.set(first, completed("failure"));
	const replacement = select(second);
	receipts.delete(first);
	assert.equal(replacement.claim(), false);
	assert.equal(select(second).candidate, first);
	assert.deepEqual(requests, [first]);
});

test("selection is read-only; two publishers at different tips claim the same slot at dispatch", () => {
	for (const [winner, loser] of [
		[second, first],
		[first, second],
	]) {
		const { select, dir } = publisher();
		const a = select(winner);
		const b = select(loser);
		assert.equal(existsSync(dir), false);
		assert.equal(a.claim(), true);
		assert.equal(b.claim(), false);
		assert.equal(select(third).candidate, winner);
	}
});

test("two competing replacements cannot both dispatch or revive the superseded candidate", () => {
	const { select, request, receipts, requests } = publisher();
	const original = select(first);
	request(original);
	receipts.set(first, completed("failure"));
	const stale = select(second);
	const winner = select(third);
	request(winner);
	assert.equal(stale.claim(), false);
	assert.equal(original.claim(), false);
	assert.deepEqual(requests, [first, third]);
});

test("restart before sending recovers the pin; a lost acknowledgement never sends again", () => {
	const { select, request, requests } = publisher();
	assert.equal(select(first).claim(), true);
	const recovered = select(second);
	assert.equal(recovered.candidate, first);
	assert.throws(
		() =>
			request(recovered, sha => {
				requests.push(sha);
				throw Error("lost acknowledgement");
			}),
		/lost acknowledgement/,
	);
	request(select(third));
	assert.deepEqual(requests, [first]);
});

test("legacy SHA mkdir blocks replay without a GitHub receipt; publishing opens a new batch", () => {
	const { dir, select, request, receipts, requests } = publisher();
	mkdirSync(join(dir, first), { recursive: true });
	const recovered = select(second);
	assert.equal(recovered.candidate, first);
	assert.equal(recovered.claim(), false);
	receipts.set(first, completed("success"));
	assert.equal(select(third).candidate, first);
	const next = select(third, first);
	assert.equal(next.candidate, third);
	request(next);
	assert.deepEqual(requests, [third]);
});

test("a failed legacy candidate can be replaced without mistaking new request markers for old ones", () => {
	const { dir, select, request, receipts, requests } = publisher();
	mkdirSync(join(dir, first), { recursive: true });
	receipts.set(first, completed("failure"));
	request(select(second));
	assert.equal(select(third).candidate, second);
	request(select(third));
	assert.deepEqual(requests, [second]);
});

test("ambiguous legacy claims and corrupt or unreachable pins stop selection", () => {
	const { dir, select } = publisher();
	mkdirSync(join(dir, first), { recursive: true });
	mkdirSync(join(dir, second));
	assert.throws(() => select(third));
	const fresh = publisher();
	assert.equal(fresh.select(second).claim(), true);
	assert.throws(() => fresh.select(first));
	writeFileSync(join(fresh.dir, "batches", base, "0"), "partial");
	assert.throws(() => fresh.select(third));
});

test("publication starts an independent set without modifying the previous base's pin", () => {
	const { select, request, receipts, requests } = publisher();
	request(select(first));
	receipts.set(first, completed("success"));
	const next = select(second, first);
	assert.equal(next.candidate, second);
	request(next);
	assert.equal(select(third, first).candidate, second);
	assert.equal(select(third, base).candidate, first);
	assert.deepEqual(requests, [first, second]);
});
