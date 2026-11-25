import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { core } from "../core/process";
import { fixture, until } from "./test-context";

const scanPath = async (path: string, mark?: unknown) =>
	(await core().call("routines.filesScan", { path, ignored: [".git", "node_modules"], mark })).result;
const listing = (entries: Record<string, string>, complete = true) => ({ entries, complete });

function seededWatchTree(parent: string, names: readonly string[]) {
	const staging = join(parent, "staging");
	for (const name of names) {
		const file = join(staging, "tree", name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "0");
	}
	// On NTFS the first listing can report directory timestamp changes from setup.
	readdirSync(staging, { recursive: true, withFileTypes: true });
	// Move the parent, not the watched directory: delayed FSEvents for setup have no paths inside the watch.
	const ready = join(parent, "ready");
	renameSync(staging, ready);
	return join(ready, "tree");
}

describe("a native file source", () => {
	it("merges an offline comparison with a live burst and never replays the new baseline", async () => {
		const ready = Promise.withResolvers<void>();
		const f = await fixture({ ready: ready.promise, timing: { fileDebounceMs: 250, fileMaxWaitMs: 1_000 } });
		writeFileSync(join(f.work, "a.txt"), "new");
		writeFileSync(join(f.work, "c.txt"), "added");
		const id = await f.add({ source: "files", path: f.work });
		f.seed(id, { listing: listing({ "a.txt": "1:1", "b.txt": "1:1" }) });
		ready.resolve();
		await until(() =>
			expect(f.marks()[id]?.mark).toMatchObject({ listing: { entries: { "c.txt": expect.any(String) } } }),
		);
		writeFileSync(join(f.work, "a.txt"), "newer");
		await until(() => expect(f.fired).toEqual(["a.txt, b.txt, c.txt changed"]));
		await until(() =>
			expect(f.marks()[id]?.mark).toMatchObject({ listing: { entries: { "a.txt": expect.stringMatching(/:5$/) } } }),
		);
		await f.reopen();
		// A new file is positive evidence that the relaunch's watcher, not the retired one, processed this burst.
		writeFileSync(join(f.work, "d.txt"), "d");
		await until(() => expect(f.fired).toHaveLength(2));
		expect(f.fired[1]).toBe("d.txt changed");
	});

	it("reports only an unspecified change for different names outside a partial listing", async () => {
		const ready = Promise.withResolvers<void>();
		const f = await fixture({ ready: ready.promise });
		const path = seededWatchTree(f.work, ["z.txt"]);
		const id = await f.add({ source: "files", path });
		f.seed(id, { listing: listing({ "b.txt": "1:1" }, false) });
		ready.resolve();
		await until(() => expect(f.fired).toHaveLength(1));
		expect(f.fired).toEqual([`Something under ${path} changed`]);
	});

	it("baselines silently, deduplicates names and shows ten with a count of the rest", async () => {
		const f = await fixture();
		const names = Array.from({ length: 13 }, (_, i) => `sub/f${i}`);
		const path = seededWatchTree(f.work, names);
		const entries = Object.fromEntries(names.map(name => [name, expect.stringMatching(/:1$/)]));
		const id = await f.add({ source: "files", path });
		await until(() => expect(f.marks()[id]?.mark).toEqual({ listing: listing(entries) }));
		expect(f.fired).toEqual([]);
		for (const name of names) {
			writeFileSync(join(path, name), "a", { flag: "r+" });
			writeFileSync(join(path, name), "b", { flag: "r+" });
		}
		await until(() => expect(f.fired).toHaveLength(1));
		// Platforms may batch the native notifications in different orders.
		const line = f.fired[0]!;
		expect(line).toMatch(/ changed, and 3 more$/);
		const shown = line.split(" changed")[0]!.split(", ");
		expect(new Set(shown).size).toBe(10);
		expect(shown.every(name => /^sub\/f\d+$/.test(name))).toBe(true);
	});

	it("ignores .git and node_modules at any depth but not .gitignore", async () => {
		const f = await fixture();
		const names = [".git/index.lock", "src/.git/HEAD", "web/node_modules/x/index.js", "src/.gitignore"];
		const path = seededWatchTree(f.work, names);
		const id = await f.add({ source: "files", path });
		const entries = { "src/.gitignore": expect.stringMatching(/:1$/) };
		await until(() => expect(f.marks()[id]?.mark).toEqual({ listing: listing(entries) }));
		for (const name of names) writeFileSync(join(path, name), "x", { flag: "r+" });
		await until(() => expect(f.fired).toEqual(["src/.gitignore changed"]));
	});

	it("reports the creation and removal of an empty directory", async () => {
		const f = await fixture();
		const id = await f.add({ source: "files", path: f.work });
		await until(() => expect(f.marks()[id]?.mark).toEqual({ listing: listing({}) }));
		const dir = join(f.work, "folder");
		mkdirSync(dir);
		await until(() => expect(f.fired).toEqual(["folder changed"]));
		await until(() => expect(f.service.latest.runs[0]?.status).toBe("succeeded"));
		rmSync(dir, { recursive: true });
		await until(() => expect(f.fired).toEqual(["folder changed", "folder changed"]));
	});

	it("records its own writes without firing during the run or its three-second quiet window", async () => {
		let now = Date.UTC(2026, 10, 1);
		const f = await fixture({ hold: true, now: () => now, timing: { quietMs: 3_000 } });
		const id = await f.add({ source: "files", path: f.work });
		await until(() => expect(f.marks()[id]?.mark).toEqual({ listing: listing({}) }));
		const write = async (name: string) => {
			writeFileSync(join(f.work, name), name);
			await until(() =>
				expect(f.marks()[id]?.mark).toMatchObject({ listing: { entries: { [name]: expect.any(String) } } }),
			);
		};
		await f.service.command({ action: "runNow", id });
		await write("own.txt");
		f.launched[0]!.finish();
		await until(() => expect(f.service.latest.runs[0]?.status).toBe("succeeded"));
		now += 2_999;
		await f.service.command({ action: "get" });
		await write("late.txt");
		expect(f.fired).toEqual([]);
		now++;
		await f.service.command({ action: "get" });
		await write("external.txt");
		await until(() => expect(f.fired).toEqual(["external.txt changed"]));
	});

	it("drops a collected burst if a run starts before its debounce and flushes no late watcher after close", async () => {
		const f = await fixture({ hold: true, timing: { fileDebounceMs: 250, fileMaxWaitMs: 1_000 } });
		const file = join(f.work, "only.txt");
		writeFileSync(file, "a");
		const id = await f.add({ source: "files", path: file });
		await until(() =>
			expect(f.marks()[id]?.mark).toMatchObject({ listing: { entries: { "": expect.any(String) } } }),
		);
		writeFileSync(file, "bb");
		await f.service.command({ action: "runNow", id });
		await until(() =>
			expect(f.marks()[id]?.mark).toMatchObject({ listing: { entries: { "": expect.stringMatching(/:2$/) } } }),
		);
		await f.close();
		writeFileSync(file, "after close");
		expect(f.fired).toEqual([]);
	});

	it("reports a missing watch once, retries it, and fires only for changes the attached watcher sees", async () => {
		const f = await fixture({ timing: { fileRetryMs: 30 } });
		const dir = join(f.work, "absent");
		await f.add({ source: "files", path: dir });
		await until(() => expect(f.log).toHaveLength(1));
		expect(f.log[0]).toContain("ENOENT");
		await delay(100);
		expect(f.log).toHaveLength(1);
		mkdirSync(dir);
		// There is no public watcher-ready event on a retry. Write through successive retry windows until one is seen.
		for (let attempt = 0; attempt < 30 && !f.fired.length; attempt++) {
			writeFileSync(join(dir, "x.txt"), String(attempt));
			await delay(150);
		}
		expect(f.fired[0]).toBe("x.txt changed");
		expect(f.log).toHaveLength(1);
	});

	it("reattaches after its live directory disappears and is recreated at the same path", async () => {
		const f = await fixture({ timing: { fileRetryMs: 30 } });
		const dir = join(f.work, "watched");
		mkdirSync(dir);
		const id = await f.add({ source: "files", path: dir });
		await until(() => expect(f.marks()[id]?.mark).toEqual({ listing: listing({}) }));
		rmSync(dir, { recursive: true });
		await until(() => expect(f.log.some(line => line.includes(": watch:"))).toBe(true));
		mkdirSync(dir);
		for (let attempt = 0; attempt < 30 && !f.fired.includes("back.txt changed"); attempt++) {
			writeFileSync(join(dir, "back.txt"), String(attempt));
			await delay(150);
		}
		expect(f.fired).toContain("back.txt changed");
	}, 20_000);
});

describe("a files trigger's listing in the core", () => {
	it("lists the files under a folder in name order with their time and size, past .git and node_modules", async () => {
		const root = mkdtempSync(join(tmpdir(), "routine-files-"));
		try {
			const at = (path: string, text: string, seconds: number) => {
				writeFileSync(join(root, path), text);
				utimesSync(join(root, path), seconds, seconds);
			};
			mkdirSync(join(root, "src", "node_modules"), { recursive: true });
			mkdirSync(join(root, ".git"));
			at("b.txt", "bb", 1_700_000_000.5);
			at("A.txt", "a", 1_700_000_001);
			at("src/x.ts", "xyz", 1_700_000_002.25);
			at("src/node_modules/m.js", "m", 1_700_000_003);
			at(".git/HEAD", "h", 1_700_000_004);
			const listing = {
				entries: { "A.txt": "1700000001000:1", "b.txt": "1700000000500:2", "src/x.ts": "1700000002250:3" },
				complete: true,
			};
			expect(await scanPath(root)).toEqual({ listing, changed: null });
			expect(await scanPath(root, { listing: null })).toEqual({ listing, changed: Object.keys(listing.entries) });
			expect(await scanPath(join(root, "b.txt"))).toEqual({
				listing: { entries: { "": "1700000000500:2" }, complete: true },
				changed: null,
			});
			const gone = join(root, "gone");
			expect(await scanPath(gone)).toEqual({ listing: null, changed: null });
			expect(await scanPath(gone, { listing: null })).toEqual({ listing: null, changed: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
