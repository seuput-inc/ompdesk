import { describe, expect, it } from "vitest";
import { checkLowDisk, LOW_DISK_BYTES, LOW_DISK_NOTICE_EVERY_MS } from "./health-watch";

describe("the disk running low", () => {
	const watch = (free: number) => {
		const shown: number[] = [];
		let last: number | undefined;
		let now = 1_000_000;
		const deps = {
			path: "/data",
			freeBytes: async () => free,
			lastNoticeAt: () => last,
			setLastNoticeAt: (at: number) => {
				last = at;
			},
			notify: (bytes: number) => shown.push(bytes),
			now: () => now,
		};
		return {
			check: () => checkLowDisk(deps),
			later: (ms: number) => {
				now += ms;
			},
			shown,
		};
	};

	it("says nothing while there is room", async () => {
		const disk = watch(LOW_DISK_BYTES);
		expect(await disk.check()).toBe(false);
		expect(disk.shown).toEqual([]);
	});

	it("tells once a day while the disk stays low", async () => {
		const disk = watch(3 * 1024 ** 3);
		expect(await disk.check()).toBe(true);
		disk.later(LOW_DISK_NOTICE_EVERY_MS - 1);
		expect(await disk.check()).toBe(false);
		disk.later(1);
		expect(await disk.check()).toBe(true);
		expect(disk.shown).toEqual([3 * 1024 ** 3, 3 * 1024 ** 3]);
	});

	it("says nothing when the volume cannot be read", async () => {
		const shown: number[] = [];
		const result = await checkLowDisk({
			path: "/gone",
			freeBytes: async () => {
				throw new Error("ENOENT");
			},
			lastNoticeAt: () => undefined,
			setLastNoticeAt: () => {},
			notify: bytes => shown.push(bytes),
		});
		expect(result).toBe(false);
		expect(shown).toEqual([]);
	});
});
