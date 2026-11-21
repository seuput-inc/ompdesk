import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesSource, FILES_DEBOUNCE_MS, FILES_MAX_WAIT_MS, FILES_RETRY_MS } from "./files";
import { scanPath } from "./ports";
import { fakeContext, fakeWatch } from "./test-context";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("files source across a relaunch", () => {
	const listing = (entries: Record<string, string>, complete = true) => ({ entries, complete });

	it("merges live events with offline changes and saves the new baseline before firing", async () => {
		const root = mkdtempSync(join(tmpdir(), "routine-relaunch-"));
		try {
			writeFileSync(join(root, "a.txt"), "new");
			writeFileSync(join(root, "c.txt"), "added");
			const files = fakeWatch();
			const scan = vi.fn(scanPath);
			const first = fakeContext({ listing: listing({ "a.txt": "1:1", "b.txt": "1:1" }) });
			const source = createFilesSource({ path: root, watch: files.watch, scan, context: first.context });
			files.emit("a.txt");
			const { listing: baseline } = await scan.mock.results[0]!.value;
			expect(first.saved).toEqual([{ listing: baseline }]);
			expect(first.fired).toEqual([]);
			await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
			expect(first.fired).toEqual(["a.txt, b.txt, c.txt changed"]);
			await scan.mock.results[1]!.value;
			source.stop();

			const next = fakeContext(first.saved.at(-1));
			const resumed = createFilesSource({ path: root, watch: files.watch, scan, context: next.context });
			await scan.mock.results[2]!.value;
			await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
			expect(next.saved).toEqual([{ listing: baseline }]);
			expect(next.fired).toEqual([]);
			resumed.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("without a mark takes the listing as its baseline and fires nothing", async () => {
		const files = fakeWatch();
		files.control.listing = listing({ "a.txt": "1:1" });
		const { context, fired, saved } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);
		expect(saved).toEqual([{ listing: listing({ "a.txt": "1:1" }) }]);
	});

	it("lists again after each burst, the routine's own writes too, so they never fire on the next launch", async () => {
		const files = fakeWatch();
		const { context, fired, saved, state } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		await vi.advanceTimersByTimeAsync(0);
		state.running = true;
		files.control.listing = listing({ "out.txt": "5:3" });
		files.emit("out.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual([]);
		expect(saved.at(-1)).toEqual({ listing: listing({ "out.txt": "5:3" }) });
	});

	it("reports an unspecified change when a partial mark has different names", async () => {
		const root = mkdtempSync(join(tmpdir(), "routine-partial-"));
		try {
			writeFileSync(join(root, "z.txt"), "new");
			const scan = vi.fn(scanPath);
			const { context, fired } = fakeContext({ listing: listing({ "b.txt": "1:1" }, false) });
			const source = createFilesSource({ path: root, watch: fakeWatch().watch, scan, context });
			await scan.mock.results[0]!.value;
			await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
			expect(fired).toEqual([`Something under ${root} changed`]);
			source.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("files source", () => {
	it("fires once for a burst, two seconds after the last change, listing each path once", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit("src/a.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS - 1);
		files.emit("src/b.ts");
		files.emit("src/a.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS - 1);
		expect(fired).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(fired).toEqual(["src/a.ts, src/b.ts changed"]);

		files.emit("src/c.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["src/a.ts, src/b.ts changed", "src/c.ts changed"]);
	});

	it("fires on a steady stream within ten seconds of its first change", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		for (let elapsed = 0; elapsed < FILES_MAX_WAIT_MS; elapsed += 1_000) {
			files.emit(`f${elapsed}.txt`);
			await vi.advanceTimersByTimeAsync(1_000);
		}
		expect(fired).toHaveLength(1);
	});

	it("lists at most ten paths and counts the rest, with Windows separators read as slashes", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		for (let index = 0; index < 13; index++) files.emit(`dir\\f${index}.txt`);
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toHaveLength(1);
		expect(fired[0]).toBe(
			`${Array.from({ length: 10 }, (_, index) => `dir/f${index}.txt`).join(", ")} changed, and 3 more`,
		);
	});

	it("never fires for .git or node_modules", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit(".git/index.lock");
		files.emit("web/node_modules/x/index.js");
		files.emit("sub/.git/HEAD");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);
		files.emit("src/.gitignore");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["src/.gitignore changed"]);
	});

	it("takes the routine's own writes for nothing: not while its run goes, not just after, and again later", async () => {
		const files = fakeWatch();
		const { context, fired, state } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		state.running = true;
		files.emit("out.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		state.running = false;
		state.quiet = true;
		files.emit("out2.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);
		state.quiet = false;
		files.emit("real.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["real.txt changed"]);
	});

	it("drops a burst whose run started before it was told", async () => {
		const files = fakeWatch();
		const { context, fired, state } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit("a.txt");
		state.running = true;
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual([]);
	});

	it("retries a path that does not exist every minute, fires nothing, and tells the failure once", async () => {
		const files = fakeWatch();
		files.control.missing = true;
		const { context, fired, warned } = fakeContext();
		createFilesSource({ path: "/gone", watch: files.watch, scan: files.scan, context });
		expect(files.control.attempts).toBe(1);
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS * 3);
		expect(files.control.attempts).toBe(4);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("ENOENT");
		expect(fired).toEqual([]);

		files.control.missing = false;
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS);
		expect(files.live()).toHaveLength(1);
		files.emit("x.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["x.txt changed"]);
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS * 3);
		expect(files.control.attempts).toBe(5);
	});

	it("watches again a minute after its watcher failed, closing the failed one", async () => {
		const files = fakeWatch();
		const { context } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.fail();
		expect(files.watchers[0]?.closed).toBe(true);
		expect(files.live()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS);
		expect(files.live()).toHaveLength(1);
	});

	it("leaves no watcher or timer after stop, and ignores events that come after it", async () => {
		const files = fakeWatch();
		const { context, fired, saved } = fakeContext();
		const source = createFilesSource({
			path: "/p",
			watch: files.watch,
			scan: files.scan,
			context,
		});
		files.emit("a.txt");
		source.stop();
		expect(files.live()).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		files.watchers[0]?.onChange("late.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);
		expect(saved).toEqual([]);

		files.control.missing = true;
		const retrying = createFilesSource({
			path: "/gone",
			watch: files.watch,
			scan: files.scan,
			context,
		});
		retrying.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
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
