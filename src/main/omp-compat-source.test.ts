import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { OmpCompatSource } from "./omp-compat-source";

const LIST = { "0.135.0": { verified: ["19.0.0"], holding: null } };

function source(replies: (() => Response)[], file: string | null = null) {
	const clock = { now: 0 };
	let reads = 0;
	const compat = new OmpCompatSource({
		file,
		fetch: async () => {
			const reply = replies[Math.min(reads, replies.length - 1)];
			reads++;
			return reply();
		},
		now: () => clock.now,
	});
	return { compat, clock, reads: () => reads };
}

describe("OmpCompatSource", () => {
	it("reads at most every 15 minutes", async () => {
		const s = source([() => Response.json(LIST)]);
		expect(await s.compat.read()).toEqual(LIST);
		s.clock.now = 14 * 60_000;
		await s.compat.read();
		expect(s.reads()).toBe(1);
		s.clock.now = 15 * 60_000;
		await s.compat.read();
		expect(s.reads()).toBe(2);
	});

	it("keeps the last good list through a failed read, a refused shape and an outage", async () => {
		const s = source([
			() => Response.json(LIST),
			() => Response.json({ "0.135.0": { verified: ["^20.0.0"], holding: null } }),
			() => new Response("bad gateway", { status: 502 }),
			() => {
				throw new TypeError("fetch failed");
			},
		]);
		await s.compat.read();
		for (let i = 1; i <= 3; i++) {
			s.clock.now = i * 15 * 60_000;
			expect(await s.compat.read()).toEqual(LIST);
		}
	});

	it("reads no list yet as nothing verified", async () => {
		const s = source([() => new Response("404: Not Found", { status: 404 })]);
		expect(await s.compat.read()).toEqual({});
	});

	it("a launch without network follows what an earlier launch read, and nothing before any read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-compat-"));
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const file = join(dir, "omp-compat.json");
		const offline = () => {
			throw new TypeError("fetch failed");
		};
		expect(await source([offline], file).compat.read()).toBeNull();
		await source([() => Response.json(LIST)], file).compat.read();
		const restart = source([offline, () => new Response(null, { status: 404 })], file);
		expect(await Promise.all([restart.compat.read(), restart.compat.read()])).toEqual([LIST, LIST]);
		expect(restart.reads()).toBe(1);
		// The offline read does not start a freshness window.
		expect(await restart.compat.read()).toEqual({});
		// A kept copy that was tampered with is not used.
		writeFileSync(file, JSON.stringify({ "0.135.0": { verified: ["latest"], holding: null } }));
		expect(await source([offline], file).compat.read()).toBeNull();
	});
});
