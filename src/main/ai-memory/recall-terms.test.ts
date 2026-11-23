/** The service's recall corpus, from the ready transition and the native ten-minute clock. */
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureAiMemory } from "../../../e2e/fixture/fake-ai-memory-install";
import captured from "../../../native/ompdesk/crates/core/src/memsync/recall-corpus.json";
import { core } from "../core/process";
import * as stock from "../stock-helper";
import { RM_TEMP } from "../test-fake-omp";
import { MemoryCare } from "./care";
import { AiMemoryClient } from "./client";
import { type MemoryStore, serveMemoryStore } from "./memory-store-test-rig";
import { AiMemoryService } from "./service";
import type { ConclusionPage } from "./sync";
import { MemoryUpkeep } from "./upkeep";

let dir: string;
const cleanup: (() => void | Promise<void>)[] = [];
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
	cleanup.push(async () => {
		host.mockRestore();
		await helper.stop();
	});
});
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	await rm(dir, RM_TEMP);
});

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

const eventually = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 10_000 });
type Timer = { service: string; timer: number; repeat: boolean; ms: number; generation: number };

async function start(fake: { store: Pick<MemoryStore, "conclusions"> }) {
	const health = { up: true };
	const served = await serveMemoryStore(
		() => fake.store,
		() => health.up,
	);
	cleanup.push(served.close);
	const memory = await fixtureAiMemory(dir);
	const url = served.server.url!;
	await writeFile(join(dir, "config.toml"), `bind = "${new URL(url).host}"\n`);
	const client = new AiMemoryClient({ url: () => url, dataDir: () => dir });
	const log = vi.fn();
	const upkeep = new MemoryUpkeep({ client, stateFile: join(dir, "upkeep.json"), log });
	const care = new MemoryCare({ client, stateFile: join(dir, "care.json"), version: "1", log });
	const file = join(dir, "recall-terms.json");
	let now = Date.now();
	const timers: Timer[] = [];
	const off = core().on("aimemory.service.timer", (data, _bin, generation) => {
		const timer = data as Omit<Timer, "generation">;
		if (timer.ms === 600_000 && timer.repeat) timers.push({ ...timer, generation });
	});
	const service = new AiMemoryService({
		platform: process.platform === "win32" ? "win32" : "darwin",
		arch: "x64",
		automatic: true,
		toolsDir: join(dir, "tools"),
		bundledDir: null,
		binaryOverride: memory.bin,
		noService: true,
		home: dir,
		agentDir: () => join(dir, "agent"),
		rootDir: join(dir, "root"),
		terminalPref: () => false,
		persistTerminal: () => {},
		spawnEnv: async () => ({
			...process.env,
			...memory.env,
			HOME: dir,
			USERPROFILE: dir,
			AI_MEMORY_DATA_DIR: dir,
			PI_CODING_AGENT_DIR: join(dir, "agent"),
		}),
		onState: () => {},
		log,
		quality: () => ({ upkeep: upkeep.service, care: care.service, recallTermsFile: file }),
		now: () => now,
		pollMs: 3_600_000,
		healthWaitMs: 0,
	});
	cleanup.push(() => {
		service.dispose();
		care.dispose();
		upkeep.dispose();
		off();
	});
	await service.start();
	expect(service.state().phase, service.state().detail ?? "").toBe("ready");
	await eventually(() => expect(timers).toHaveLength(1));
	return {
		health,
		log,
		timers,
		service,
		check: async () => {
			now += 6_000;
			await service.refresh();
		},
		fire: (timer = timers[timers.length - 1]!) =>
			core().call(
				"aimemory.service.fire",
				{ service: timer.service, timer: timer.timer, now },
				{ generation: timer.generation },
			),
	};
}

describe("the service's recall term corpus", { timeout: 60_000 }, () => {
	it("adds only new rows on a later refresh and writes nothing when unchanged", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["memory server"], synced: ["memory prompt"] });
		const index = await start(fake);
		await eventually(async () =>
			expect(await read(file)).toMatchObject({
				v: 1,
				store: "db1",
				native: 1,
				synced: 1,
				n: 2,
				df: { memory: 2, server: 1, prompt: 1 },
			}),
		);
		await utimes(file, 1, 1);
		const before = (await stat(file)).mtimeMs;
		fake.calls.length = 0;
		await index.fire();
		await eventually(() =>
			expect(fake.calls).toEqual([
				["native", 1],
				["synced", 1],
			]),
		);
		expect((await stat(file)).mtimeMs).toBe(before);
		fake.streams.native.push("memory tailscale");
		fake.calls.length = 0;
		await index.fire();
		await eventually(async () =>
			expect(await read(file)).toMatchObject({ native: 2, n: 3, df: { memory: 3, tailscale: 1 } }),
		);
		expect(fake.calls[0]).toEqual(["native", 1]);
		// Windows has no POSIX modes (a file's mode reads 0o666 whatever was asked); the store tests skip it alike.
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it("pages both streams and counts repeated, stemmed and empty documents as the bridge did", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({
			native: [...Array<string>(200).fill("the"), ...captured.bodies],
			synced: Array<string>(201).fill("memory memory"),
		});
		await start(fake);
		await eventually(async () => expect((await read(file)).synced).toBe(201));
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

	it("retries with the current stock host when it was unavailable on ready entry", async () => {
		const file = join(dir, "recall-terms.json");
		const host = stock.stockHelperHost();
		vi.mocked(stock.stockHelperHost).mockImplementation(() => {
			throw new Error("Stock helper not configured yet");
		});
		const index = await start(fakeStore({ native: ["hello memory"], synced: [] }));
		await eventually(() => expect(index.log).toHaveBeenCalledWith("recall-terms-failed", expect.anything()));
		vi.mocked(stock.stockHelperHost).mockReturnValue(host);
		await index.fire();
		await eventually(async () => expect(await read(file)).toMatchObject({ native: 1, n: 1, df: { memory: 1 } }));
	});

	it("keeps one cadence across ready stretches and resumes from disk on the replacement core", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["alpha"], synced: [] });
		const index = await start(fake);
		await eventually(async () => expect((await read(file)).native).toBe(1));
		const original = index.timers[0]!;
		fake.calls.length = 0;
		await index.check();
		index.health.up = false;
		await index.check();
		expect(index.service.state().phase).toBe("unreachable");
		await index.fire(original);
		fake.streams.native.push("beta");
		index.health.up = true;
		await index.check();
		await eventually(async () => expect((await read(file)).native).toBe(2));
		expect(index.timers).toEqual([original]);
		expect(fake.calls).toEqual([
			["native", 1],
			["synced", 0],
		]);
		fake.streams.synced.push("gamma");
		await index.fire(original);
		await eventually(async () => expect((await read(file)).synced).toBe(1));

		fake.calls.length = 0;
		fake.streams.native.push("delta");
		core().abandon("replace the test's recall core");
		await eventually(() => expect(index.timers).toHaveLength(2));
		await expect(index.fire(original)).rejects.toMatchObject({ code: "core_exited" });
		await eventually(async () => expect(await read(file)).toMatchObject({ native: 3, synced: 1, n: 4 }));
		expect(fake.calls).toEqual([
			["native", 2],
			["synced", 1],
		]);
	});

	it("does not overlap a ready-entry refresh with timer ticks", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["only once"], synced: [] });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { conclusions } = fake.store;
		fake.store.conclusions = async (source, after, limit) => {
			if (source === "native") {
				started.resolve();
				await release.promise;
			}
			return conclusions(source, after, limit);
		};
		try {
			const index = await start(fake);
			await started.promise;
			await index.fire();
			await index.fire();
			await index.check();
		} finally {
			release.resolve();
		}
		await eventually(async () => expect((await read(file)).n).toBe(1));
		expect(fake.calls).toEqual([
			["native", 0],
			["synced", 0],
		]);
	});

	it("drops the old synced counts on a store change even when the native cursor is zero", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: [], synced: ["old store"] });
		const index = await start(fake);
		await eventually(async () => expect((await read(file)).store).toBe("db1"));
		fake.state.store = "db2";
		fake.streams.synced.splice(0, 1, "new store");
		await index.fire();
		await eventually(async () =>
			expect(await read(file)).toEqual({ v: 1, store: "db2", native: 0, synced: 1, n: 1, df: { new: 1, store: 1 } }),
		);
	});

	it("keeps the previous complete file if the store changes again during a rebuild", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["old words"], synced: [] });
		const index = await start(fake);
		await eventually(async () => expect((await read(file)).store).toBe("db1"));
		const before = await readFile(file, "utf8");
		const { conclusions } = fake.store;
		fake.state.store = "db2";
		fake.store.conclusions = async (source, after, limit) => {
			if (source === "synced") fake.state.store = "db3";
			return conclusions(source, after, limit);
		};
		await index.fire();
		await eventually(() => expect(index.log).toHaveBeenCalledWith("recall-terms-failed", expect.anything()));
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("rebuilds from zero when the store changes or a cursor is past last", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["alpha beta", "alpha gamma"], synced: [] });
		const index = await start(fake);
		await eventually(async () => expect((await read(file)).native).toBe(2));
		fake.state.store = "db2";
		fake.streams.native.splice(0, 2, "delta epsilon");
		await index.fire();
		await eventually(async () =>
			expect(await read(file)).toMatchObject({ store: "db2", n: 1, df: { delta: 1, epsilon: 1 } }),
		);
		fake.streams.native.splice(0, 1, "zeta eta", "zeta theta");
		await index.fire();
		await eventually(async () => expect(await read(file)).toMatchObject({ native: 2, n: 2 }));
		fake.streams.native.length = 0;
		fake.streams.native.push("omega sigma");
		await index.fire();
		await eventually(async () => expect(await read(file)).toMatchObject({ n: 1, df: { omega: 1, sigma: 1 } }));
	});

	it("logs a failing read and keeps the old file", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["memory server"], synced: [] });
		const index = await start(fake);
		await eventually(async () => expect((await read(file)).native).toBe(1));
		const before = await readFile(file, "utf8");
		fake.state.fail = true;
		fake.streams.native.push("more words");
		await index.fire();
		await eventually(() => expect(index.log).toHaveBeenCalledWith("recall-terms-failed", expect.anything()));
		expect(await readFile(file, "utf8")).toBe(before);
	});
});
