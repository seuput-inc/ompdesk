/** The recall term corpus (recall-terms.ts): incremental refresh, rebuild on a moved store, quiet failures. */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import captured from "../../../native/ompdesk/crates/core/src/memsync/recall-corpus.json";
import * as stock from "../stock-helper";
import { serveMemoryStore } from "./memory-store-test-rig";
import { RecallTermsIndex } from "./recall-terms";
import type { ConclusionPage } from "./sync";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "recall-terms-"));
	const bridge = resolve("resources/gui-bridge");
	const helper = new stock.StockHelper(bridge, {
		launch: async worker => ({
			bin: "bun",
			args: [join(bridge, "stock-helper/host.ts"), worker],
			env: { ...process.env, OMP_PACKAGE_ROOT: dir, PI_CODING_AGENT_DIR: dir },
		}),
	});
	const host = vi.spyOn(stock, "stockHelperHost").mockReturnValue(helper.host);
	onTestFinished(async () => {
		host.mockRestore();
		await helper.stop();
	});
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A fake store holding `bodies` per stream; seq = index + 1. */
function fakeStore(streams: { native: string[]; synced: string[] }, state = { store: "db1", fail: false }) {
	const calls: [string, number][] = [];
	return {
		state,
		calls,
		streams,
		store: {
			async conclusions(source: "native" | "synced", after: number, limit: number): Promise<ConclusionPage> {
				if (state.fail) throw new Error("down");
				calls.push([source, after]);
				const all = streams[source];
				const slice = all.slice(after, after + limit);
				return {
					rows: slice.map((body, i) => ({
						seq: after + i + 1,
						workspace: "w",
						project: "p",
						id: `${source}${after + i}`,
						sessionId: "s",
						title: "t",
						body,
						at: "",
					})),
					next: after + slice.length,
					more: after + slice.length < all.length,
					store: state.store,
					last: all.length,
				};
			},
		},
	};
}

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));

/** The fake store as the core's client reaches it: a memory server on 127.0.0.1. */
async function serve(store: ReturnType<typeof fakeStore>["store"]) {
	const served = await serveMemoryStore(() => store);
	onTestFinished(() => served.close());
	return () => served.server;
}

describe("RecallTermsIndex", () => {
	it("adds only new rows on a later refresh and writes nothing when unchanged", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["memory server"], synced: ["memory prompt"] });
		const index = new RecallTermsIndex({ server: await serve(fake.store), file });
		await index.refresh();
		expect(await read(file)).toMatchObject({
			v: 1,
			store: "db1",
			native: 1,
			synced: 1,
			n: 2,
			df: { memory: 2, server: 1, prompt: 1 },
		});
		const before = (await stat(file)).mtimeMs;
		await new Promise(resolve => setTimeout(resolve, 20));
		await index.refresh();
		expect((await stat(file)).mtimeMs).toBe(before);
		fake.streams.native.push("memory tailscale");
		fake.calls.length = 0;
		await index.refresh();
		expect(fake.calls[0]).toEqual(["native", 1]);
		expect(await read(file)).toMatchObject({ native: 2, n: 3, df: { memory: 3, tailscale: 1 } });
		// Windows has no POSIX modes (a file's mode reads 0o666 whatever was asked); the store tests skip it alike.
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it("pages both streams and counts repeated, stemmed and empty documents as the bridge did", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({
			native: [...Array<string>(200).fill("the"), ...captured.bodies],
			synced: Array<string>(201).fill("memory memory"),
		});
		const index = new RecallTermsIndex({ server: await serve(fake.store), file });
		const first = index.refresh();
		expect(index.refresh()).toBe(first);
		await first;
		expect(fake.calls).toEqual([
			["native", 0],
			["native", 200],
			["synced", 0],
			["synced", 200],
		]);
		expect(await read(file)).toEqual({
			v: 1,
			store: "db1",
			native: 200 + captured.bodies.length,
			synced: 201,
			n: 401 + captured.stats.n,
			df: { ...captured.stats.df, memory: captured.stats.df.memory + 201 },
		});
	});

	it("drops the old synced counts on a store change even when the native cursor is zero", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: [], synced: ["old store"] });
		const index = new RecallTermsIndex({ server: await serve(fake.store), file });
		await index.refresh();
		fake.state.store = "db2";
		fake.streams.synced.splice(0, 1, "new store");
		await index.refresh();
		expect(await read(file)).toEqual({ v: 1, store: "db2", native: 0, synced: 1, n: 1, df: { new: 1, store: 1 } });
	});

	it("keeps the previous complete file if the store changes again during a rebuild", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["old words"], synced: [] });
		const log = vi.fn();
		const index = new RecallTermsIndex({ server: await serve(fake.store), file, log });
		await index.refresh();
		const before = await readFile(file, "utf8");
		const { conclusions } = fake.store;
		fake.state.store = "db2";
		fake.store.conclusions = async (source, after, limit) => {
			if (source === "synced") fake.state.store = "db3";
			return conclusions(source, after, limit);
		};
		await index.refresh();
		expect(log).toHaveBeenCalledWith("recall-terms-failed", expect.anything());
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("rebuilds from zero when the store changes or a cursor is past last", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["alpha beta", "alpha gamma"], synced: [] });
		const server = await serve(fake.store);
		await new RecallTermsIndex({ server, file }).refresh();
		fake.state.store = "db2";
		fake.streams.native.splice(0, 2, "delta epsilon");
		await new RecallTermsIndex({ server, file }).refresh();
		expect(await read(file)).toMatchObject({ store: "db2", n: 1, df: { delta: 1, epsilon: 1 } });
		fake.streams.native.splice(0, 1, "zeta eta", "zeta theta");
		const index = new RecallTermsIndex({ server, file });
		await index.refresh();
		expect(await read(file)).toMatchObject({ native: 2, n: 2 });
		fake.streams.native.length = 0;
		fake.streams.native.push("omega sigma");
		await index.refresh();
		expect(await read(file)).toMatchObject({ n: 1, df: { omega: 1, sigma: 1 } });
	});

	it("logs a failing read and keeps the old file", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["memory server"], synced: [] });
		const logs: string[] = [];
		const index = new RecallTermsIndex({ server: await serve(fake.store), file, log: message => logs.push(message) });
		await index.refresh();
		const before = await readFile(file, "utf8");
		fake.state.fail = true;
		fake.streams.native.push("more words");
		await expect(index.refresh()).resolves.toBeUndefined();
		expect(logs.length).toBeGreaterThan(0);
		expect(await readFile(file, "utf8")).toBe(before);
	});
});
