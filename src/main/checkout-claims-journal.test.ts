/**
 * The claims journal as deltas (resources/gui-bridge/modes/checkout-claims.ts `claimsDelta`, `replayClaims`): whatever
 * a real `ClaimBook` does, the journal replays to exactly its files, in order, so a restart restores what it held.
 */
import { describe, expect, it } from "vitest";
import {
	CLAIMS_FULL_EVERY,
	ClaimBook,
	claimsDelta,
	replayClaims,
} from "../../resources/gui-bridge/modes/checkout-claims";

/** mulberry32: a seeded generator, so a failing sequence is replayed by its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FILES = Array.from({ length: 40 }, (_, i) => `/work/app/src/f${i}.ts`);

describe("the claims journal", () => {
	it("replays to the book's files after every change, whole sets and deltas mixed", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const pick = random(seed);
			const owners = ["main", "sub"];
			const book = new ClaimBook();
			const journal: unknown[] = [];
			let written: readonly string[] = [];
			let deltas = CLAIMS_FULL_EVERY;
			const open: Array<{ owner: string; id: string }> = [];
			for (let step = 0; step < 80; step++) {
				const roll = pick();
				if (roll < 0.4) {
					const id = `c${step}`;
					const owner = owners[Math.floor(pick() * owners.length)] as string;
					const paths = FILES.filter(() => pick() < 0.08);
					book.begin({
						owner,
						id,
						paths,
						keepsOnError: pick() < 0.5,
						drops: [],
						refresh: false,
						extra: undefined,
					});
					open.push({ owner, id });
				} else if (roll < 0.7 && open.length > 0) {
					const call = open.splice(Math.floor(pick() * open.length), 1)[0];
					if (call) book.end(call.owner, call.id, { isError: pick() < 0.3 });
				} else if (roll < 0.85) {
					book.retire(book.files.filter(() => pick() < 0.3).map(file => ({ file, stamp: book.stamp(file) })));
				} else if (roll < 0.95) {
					const owner = owners[Math.floor(pick() * owners.length)] as string;
					book.agentEnded(owner);
					open.splice(0, open.length, ...open.filter(call => call.owner !== owner));
				} else {
					// A move in the session tree: the next entry is whole.
					deltas = CLAIMS_FULL_EVERY;
					written = [];
				}
				const delta = claimsDelta(written, book.files);
				if (!delta) continue;
				const whole = deltas >= CLAIMS_FULL_EVERY || delta.front.length + delta.removed.length >= book.files.length;
				journal.push(whole ? book.snapshot() : delta);
				written = [...book.files];
				deltas = whole ? 0 : deltas + 1;
				expect(replayClaims(journal)?.files, `seed ${seed} step ${step}`).toEqual(book.files);
			}
			const restored = new ClaimBook();
			restored.restore(replayClaims(journal));
			expect(restored.files, `seed ${seed}`).toEqual(book.files);
		}
	});

	it("writes nothing when the set did not change, and only the change when one file joins a large set", () => {
		const set = FILES.slice(1);
		expect(claimsDelta(set, set)).toBeUndefined();
		expect(claimsDelta(set, [FILES[0] as string, ...set])).toEqual({ front: [FILES[0]], removed: [] });
		expect(claimsDelta(set, [set[5] as string, ...set.filter(file => file !== set[5])])).toEqual({
			front: [set[5]],
			removed: [],
		});
		expect(claimsDelta(set, set.slice(1))).toEqual({ front: [], removed: [set[0]] });
	});

	it("reads a journal written before deltas: its newest whole set", () => {
		expect(
			replayClaims([
				{ files: ["/a", "/b"], stamps: [2, 1] },
				{ files: ["/c"], stamps: [3], at: 5 },
			]),
		).toEqual({
			files: ["/c"],
		});
		expect(replayClaims([])).toBeUndefined();
	});
});
