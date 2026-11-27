import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	Connection,
	DATA_OFFSET,
	HUB_CALL_DEADLINE_MS,
	HUB_LIVENESS_MS,
	HUB_WAIT_LIMIT_MS,
	Hub,
	type HubInstanceHandler,
	type HubItem,
	LENGTH,
	STATE,
} from "./hub";
import { CoreError, type CoreLossStep, core, stopCore } from "./process";

afterAll(() => stopCore());

/** The error `run` throws, which must be a CoreError. */
function thrown(run: () => unknown): CoreError {
	try {
		run();
	} catch (error) {
		if (error instanceof CoreError) return error;
		throw error;
	}
	throw new Error("it threw nothing");
}

/** What main logs of the core's loss and of calls it gave up (`core().report`), until `restore`. */
function recordReports() {
	const seen: ({ step: CoreLossStep } & Record<string, unknown>)[] = [];
	const previous = core().report;
	core().report = (step, details) => seen.push({ step, ...details });
	return Object.assign(seen, { restore: () => (core().report = previous) });
}

/** A `test:probe` instance of the real core's hub, and everything it told main. */
function probe(hub: Hub, answer: (q: string, item: HubItem) => unknown = () => "yes") {
	const items: HubItem[] = [];
	const lost: CoreError[] = [];
	const handler: HubInstanceHandler = {
		item: item => items.push(item),
		ask: (q, item) => answer(q, item),
		lost: error => lost.push(error),
	};
	const id = hub.nextId();
	hub.open(id, "test:probe", {}, handler);
	return { id, items, lost };
}

/**
 * Kills the running core after `ms`, from another process: main's own thread is blocked meanwhile. Waits first for the
 * core's owner to say which process it is (the pid comes with the owner's answer to `core.start`).
 */
async function killCoreAfter(ms: number): Promise<void> {
	await vi.waitFor(() => expect(core().pid).not.toBeNull(), { timeout: 10_000, interval: 5 });
	const pid = core().pid;
	spawn(process.execPath, ["-e", `setTimeout(() => process.kill(${pid}, "SIGKILL"), ${ms})`], {
		stdio: "ignore",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	}).unref();
}

describe("the hub connection", () => {
	it("answers a call after main handled every item the call made", () => {
		const hub = new Hub();
		const instance = probe(hub);
		expect(hub.call(instance.id, "push", { n: 7 })).toBe(7);
		expect(instance.items).toEqual([{ k: "n", n: 7 }]);
	});

	it("lets main answer a synchronous question inside a call, nested calls included", () => {
		const hub = new Hub();
		const order: string[] = [];
		const instance = probe(hub, () => {
			order.push("asked");
			// A listener that calls back in while the core's rule waits for this answer.
			expect(hub.call(instance.id, "push", { n: 1 })).toBe(1);
			order.push("nested answered");
			return "from main";
		});
		expect(hub.call(instance.id, "ask")).toBe("from main");
		expect(order).toEqual(["asked", "nested answered"]);
		expect(instance.items).toEqual([{ k: "n", n: 1 }, { k: "after" }]);
	});

	it.each([
		// The question's answer goes out at once; the core's rule answers the outer call before the nested one's.
		{ outer: "askPoke", nested: "push", result: "from main", nestedResult: 2 },
		// The nested call wakes the outer one's rule: its answer comes right behind the nested call's.
		{ outer: "askWaitPoke", nested: "fire", result: "woke", nestedResult: null },
	])(
		"hands a call the answer a call nested in its handling read ($outer)",
		({ outer, nested, result, nestedResult }) => {
			const hub = new Hub();
			const answers: unknown[] = [];
			const id = hub.nextId();
			hub.open(
				id,
				"test:probe",
				{},
				{
					item: item => {
						if (item.k === "poke") answers.push(hub.call(id, nested, { n: 2 }));
					},
					ask: () => "from main",
					lost: () => {},
				},
			);
			expect(hub.call(id, outer)).toBe(result);
			expect(answers).toEqual([nestedResult]);
		},
	);

	it("answers a later question once main's promise settles, without blocking main", async () => {
		const hub = new Hub();
		const instance = probe(hub, () => Promise.resolve("later"));
		await expect(hub.callLater(instance.id, "askLater")).resolves.toBe("later");
	});

	it("runs what a call woke in the core as microtasks after the caller's own code, as a promise continuation", async () => {
		const hub = new Hub();
		const instance = probe(hub);
		// The rule's continuation runs once `fire` came.
		const waited = hub.callLater(instance.id, "wait");
		hub.call(instance.id, "fire");
		expect(instance.items).toEqual([]);
		await Promise.resolve();
		expect(instance.items).toEqual([{ k: "woke" }]);
		await expect(waited).resolves.toBe("woke");
	});

	it("answers a drain whose ping is older than the hand-over that took its lines", async () => {
		const hub = new Hub();
		const instance = probe(hub, () => "yes");
		// Each synchronous question's answer goes out inside the call; the core's reply to it can come while the worker
		// is between hand-overs, so a ping waits in main's queue for lines a later wait already took.
		for (let round = 0; round < 50; round++) {
			hub.call(instance.id, "ask");
			await new Promise(resolve => setImmediate(resolve));
		}
		expect(instance.lost).toEqual([]);
	});

	it("gives up a call the core has not answered by its bound and keeps the core; the call's late effects land once and its late answer settles nothing else", async () => {
		const reports = recordReports();
		try {
			const hub = new Hub();
			const instance = probe(hub);
			const later = Promise.withResolvers<string>();
			const other = probe(hub, () => later.promise);
			// Another call still pending in the core, which the give-up must leave alone.
			const pending = hub.callLater(other.id, "askLater");
			const pid = core().pid;
			const generation = hub.generation;
			const started = performance.now();
			// `wait` changes the instance (its `woke`) only when `fire` comes: a mutating call that commits late.
			const error = thrown(() => hub.call(instance.id, "wait"));
			const blocked = performance.now() - started;
			expect(error.code).toBe("hub_unknown");
			expect(error.message).toMatch(/^wait: .*the core may still carry it out/);
			expect(blocked).toBeGreaterThanOrEqual(HUB_CALL_DEADLINE_MS - 50);
			expect(blocked).toBeLessThan(HUB_WAIT_LIMIT_MS + 1_000);
			expect(reports).toContainEqual(expect.objectContaining({ step: "gave-up", method: "wait" }));
			// The next call gets its own answer; the late `wait` commits once, and its answer is dropped, not replayed.
			expect(hub.call(instance.id, "fire")).toBeNull();
			await vi.waitFor(() => expect(instance.items).toEqual([{ k: "woke" }]));
			expect(reports).toContainEqual(expect.objectContaining({ step: "late-answer", method: "wait", ok: true }));
			expect(instance.items).toEqual([{ k: "woke" }]);
			later.resolve("its own");
			await expect(pending).resolves.toBe("its own");
			expect([...instance.lost, ...other.lost]).toEqual([]);
			expect(hub.generation).toBe(generation);
			expect(core().pid).toBe(pid);
			expect(reports.map(report => report.step)).not.toContain("abandoned");
		} finally {
			reports.restore();
		}
	}, 15_000);

	it("names the silent side of a given-up wait truly under a test's fake clock", () => {
		// turn-resume-limit.test.ts lost a wait with its clock set back two weeks and moved on by days: the trace
		// compared that fake time with the worker's real one and said the thread never took the wait.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-11-12T02:08:02Z"));
			vi.advanceTimersByTime(319_918_000);
			const hub = new Hub();
			const instance = probe(hub);
			expect(thrown(() => hub.call(instance.id, "wait")).message).toMatch(/its thread took the wait after \d+ ms/);
		} finally {
			vi.useRealTimers();
		}
	}, 15_000);

	it("waits for a core whose hub thread is held in one job for 3 s, and keeps that core", () => {
		const hub = new Hub();
		const instance = probe(hub);
		const generation = hub.generation;
		expect(hub.call(instance.id, "stall", { ms: 3_000 })).toBe(3_000);
		expect(instance.lost).toEqual([]);
		expect(hub.generation).toBe(generation);
	}, 15_000);

	it("gives up a call whose hub thread stays in one job past the wait's limit, and keeps the core that still beats", () => {
		const hub = new Hub();
		const instance = probe(hub);
		const pid = core().pid;
		const started = performance.now();
		const error = thrown(() => hub.call(instance.id, "stall", { ms: 6_000 }));
		const blocked = performance.now() - started;
		expect(error.code).toBe("hub_unknown");
		expect(blocked).toBeGreaterThanOrEqual(HUB_WAIT_LIMIT_MS - 50);
		expect(blocked).toBeLessThan(HUB_WAIT_LIMIT_MS + 1_000);
		// The trace names the job the hub's thread sat in: main's own call.
		expect(error.message).toMatch(/the core's hub thread was \d+ ms into this call/);
		// Queued behind the stall, the next call is answered once it ends.
		expect(hub.call(instance.id, "push", { n: 2 })).toBe(2);
		expect(instance.lost).toEqual([]);
		expect(core().pid).toBe(pid);
	}, 20_000);

	it("ends a core whose hub thread sits in one job past the liveness window, and opens a new core after", async () => {
		const hub = new Hub();
		const instance = probe(hub);
		const pid = core().pid;
		const started = performance.now();
		expect(thrown(() => hub.call(instance.id, "stall", { ms: 14_000 })).code).toBe("hub_unknown");
		await vi.waitFor(() => expect(instance.lost).toHaveLength(1), { timeout: 15_000, interval: 50 });
		expect(performance.now() - started).toBeGreaterThanOrEqual(HUB_LIVENESS_MS - 300);
		expect(instance.lost[0]?.message).toMatch(/the core's hub thread sat \d+ ms in one job/);
		const again = probe(hub);
		expect(hub.call(again.id, "push", { n: 3 })).toBe(3);
		expect(core().pid).not.toBe(pid);
	}, 30_000);

	it("never holds main past the wait's limit, nor the hang watchdog's 5 s, while its worker reaches no hub", () => {
		const dir = mkdtempSync(join(tmpdir(), "hub-none-"));
		const address =
			process.platform === "win32"
				? `\\\\.\\pipe\\ompdesk-hub-none-${process.pid}-${Date.now()}`
				: join(dir, "none.sock");
		// Generation -1: no core of this process is abandoned for it.
		const hub = new Hub(() => ({ address, token: "t", generation: -1 }));
		const started = performance.now();
		try {
			expect(() => hub.barrier()).toThrow(CoreError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const blocked = performance.now() - started;
		expect(blocked).toBeLessThan(HUB_WAIT_LIMIT_MS + 500);
		expect(blocked).toBeLessThan(5_000);
	}, 15_000);

	it("never hands a question of the next core the answer to one the lost core asked", async () => {
		const hub = new Hub();
		const stale = Promise.withResolvers<string>();
		let asked = 0;
		const old = probe(hub, () => {
			asked++;
			return stale.promise;
		});
		const unanswered = hub.callLater(old.id, "askLater").catch((error: unknown) => error);
		// Main took the question (its promise is pending) before the core is lost.
		hub.barrier();
		expect(asked).toBe(1);
		await killCoreAfter(200);
		expect(() => hub.call(old.id, "wait")).toThrow(CoreError);
		expect(await unanswered).toBeInstanceOf(CoreError);
		// The next core's first question carries the number the lost core's had.
		const fresh = Promise.withResolvers<string>();
		const next = probe(hub, () => fresh.promise);
		const answer = hub.callLater(next.id, "askLater");
		hub.barrier();
		stale.resolve("stale");
		await new Promise(resolve => setImmediate(resolve));
		fresh.resolve("fresh");
		await expect(answer).resolves.toBe("fresh");
	});

	it("wakes main at once when the core ends in the middle of a call (the quit, a crash)", async () => {
		const hub = new Hub();
		const instance = probe(hub);
		await killCoreAfter(200);
		const started = performance.now();
		expect(() => hub.call(instance.id, "wait")).toThrow(CoreError);
		expect(performance.now() - started).toBeLessThan(HUB_CALL_DEADLINE_MS);
		expect(instance.lost).toHaveLength(1);
	});

	it("reads a call's params again when the core is lost under it, so the second call carries what main reads after the loss", async () => {
		const hub = new Hub();
		const order: string[] = [];
		let first = true;
		const open = () =>
			probe(hub, () => {
				// The first core ends while its rule waits on main, as a core that stops answering mid-call.
				if (first) {
					first = false;
					process.kill(core().pid ?? 0, "SIGKILL");
				}
				return "answered";
			});
		let instance = open();
		// The owner's answer, which names the core's process, comes on main's next turn.
		await vi.waitFor(() => expect(core().pid).not.toBeNull(), { timeout: 10_000, interval: 5 });
		const lostOne = instance;
		// Each read says whether the instance it goes to is the next core's, opened after the loss.
		const params = () => {
			order.push(instance === lostOne ? "read before the loss" : "read after the loss");
			return {};
		};
		const answer = hub.callOnce<string>(
			() => {
				if (instance.lost.length > 0) instance = open();
				return instance.id;
			},
			"ask",
			params,
		);
		expect(answer).toBe("answered");
		expect(order).toEqual(["read before the loss", "read after the loss"]);
	});
});

/**
 * A hub on a thread of its own that answers each request (by the method it runs), one after another as the hub thread
 * does, after its `delays` ms; `null` answers that request and everything after it never, as a frozen core. It sends
 * no beats: what it leaves silent is silent.
 */
const STAND_IN = `
const { parentPort, workerData } = require("node:worker_threads");
const net = require("node:net");
const { address, delays } = workerData;
net.createServer(socket => {
	socket.on("error", () => {});
	let buffer = "";
	let hello = false;
	let chain = Promise.resolve();
	socket.on("data", chunk => {
		buffer += chunk;
		let end;
		while ((end = buffer.indexOf("\\n")) >= 0) {
			const request = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (!hello) {
				hello = true;
				continue;
			}
			const method = request.method === "hub.call" ? request.params.method : request.method;
			const delay = method in delays ? delays[method] : 0;
			chain = chain.then(() => {
				const answered = Promise.withResolvers();
				if (delay === null) return answered.promise;
				setTimeout(() => {
					socket.write(JSON.stringify({ id: request.id, ok: true, result: method }) + "\\n" + '{"tick":true}\\n');
					answered.resolve();
				}, delay);
				return answered.promise;
			});
		}
	});
}).listen(address, () => parentPort.postMessage("listening"));
`;

describe("a core that goes silent", () => {
	// Real time, as in the cases above: main's thread blocks in `Atomics.wait` against the worker's real clock and the
	// stand-in's silence runs on its own thread, so no fake timer can move either. No core of this process runs, so a
	// lost stand-in abandons none.
	beforeAll(() => stopCore());

	async function standIn(delays: Record<string, number | null>) {
		const dir = mkdtempSync(join(tmpdir(), "hub-stand-in-"));
		const address =
			process.platform === "win32"
				? `\\\\.\\pipe\\ompdesk-hub-stand-in-${process.pid}-${Date.now()}`
				: join(dir, "hub.sock");
		const server = new Worker(STAND_IN, { eval: true, workerData: { address, delays } });
		await once(server, "message");
		const hub = new Hub(() => ({ address, token: "t", generation: core().hubEndpointGeneration() }));
		const lost: CoreError[] = [];
		const id = hub.nextId();
		hub.open(id, "stand-in", {}, { item: () => {}, ask: () => null, lost: error => lost.push(error) });
		const close = async () => {
			await server.terminate();
			rmSync(dir, { recursive: true, force: true });
		};
		return { hub, id, lost, close };
	}

	it("gives up a call the core leaves silent for 3 s, keeps the core, and the next call gets its own answer", async () => {
		const reports = recordReports();
		const { hub, id, lost, close } = await standIn({ slow: 3_000 });
		try {
			const started = performance.now();
			const error = thrown(() => hub.call(id, "slow"));
			const blocked = performance.now() - started;
			expect(error.code).toBe("hub_unknown");
			expect(blocked).toBeGreaterThanOrEqual(HUB_CALL_DEADLINE_MS - 50);
			expect(blocked).toBeLessThan(3_000);
			// Queued behind `slow`, which answers late: that answer settles nothing, this call reads its own.
			expect(hub.call(id, "fast")).toBe("fast");
			expect(reports).toContainEqual(expect.objectContaining({ step: "late-answer", method: "slow" }));
			expect(lost).toEqual([]);
		} finally {
			reports.restore();
			await close();
		}
	}, 15_000);

	it("ends a core that sends nothing at all past the liveness window, judged off main's thread", async () => {
		const { hub, id, lost, close } = await standIn({ frozen: null });
		try {
			const started = performance.now();
			expect(thrown(() => hub.call(id, "frozen")).code).toBe("hub_unknown");
			// The call alone gave up: the core is not judged dead for it.
			expect(lost).toEqual([]);
			await vi.waitFor(() => expect(lost).toHaveLength(1), { timeout: HUB_LIVENESS_MS + 5_000, interval: 50 });
			expect(performance.now() - started).toBeGreaterThanOrEqual(HUB_LIVENESS_MS - 300);
			expect(lost[0]?.code).toBe("hub_lost");
			expect(lost[0]?.message).toMatch(/the core sent nothing, beats included, for \d+ ms/);
		} finally {
			await close();
		}
	}, 30_000);
});

describe("the hub worker's line reader", () => {
	it("keeps a Korean character whole when a chunk ends in the middle of it", async () => {
		const text = "경로 /Users/홍길동/프로젝트 이어하기";
		const bytes = Buffer.from(`${JSON.stringify({ id: 1, text })}\n`, "utf8");
		const cut = bytes.indexOf(Buffer.from("홍", "utf8")) + 1; // inside the 3-byte character
		const dir = mkdtempSync(join(tmpdir(), "hub-utf8-"));
		const address =
			process.platform === "win32"
				? `\\\\.\\pipe\\ompdesk-hub-utf8-${process.pid}-${Date.now()}`
				: join(dir, "s.sock");
		const server = createServer(socket => {
			socket.setNoDelay(true);
			socket.once("data", () => {
				socket.write(bytes.subarray(0, cut));
				setTimeout(() => socket.write(bytes.subarray(cut)), 50);
			});
		});
		await new Promise<void>(resolve => server.listen(address, resolve));
		const connection = new Connection({ address, token: "t" }, 1);
		try {
			let lines: { text?: string }[] = [];
			for (let attempt = 0; attempt < 40 && lines.length === 0; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 25));
				Atomics.store(connection.control, STATE, 1);
				connection.worker.postMessage({ wait: "drain" });
				Atomics.wait(connection.control, STATE, 1, 1000);
				// 3: the worker is writing the hand-over it claimed.
				while (Atomics.load(connection.control, STATE) === 3) Atomics.wait(connection.control, STATE, 3, 50);
				const length = Atomics.load(connection.control, LENGTH);
				const raw = Buffer.from(new Uint8Array(connection.sab, DATA_OFFSET, length)).toString("utf8");
				lines = (JSON.parse(raw) as { lines: { text?: string }[] }).lines;
				Atomics.store(connection.control, STATE, 0);
			}
			expect(lines.map(line => line.text)).toEqual([text]);
		} finally {
			await connection.worker.terminate();
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
