import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopCore } from "./core/process";
import { journalWait, TurnWaitWatch, WAIT_REPORT_MS, WAIT_SWEEP_MS, type WaitFact, waitsOn } from "./turn-wait-watch";

const START = Date.parse("2026-11-20T00:00:00.000Z");
const HOUR = 60 * 60_000;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "turn-wait-"));
});
afterAll(async () => {
	await stopCore();
	await rm(dir, { recursive: true, force: true });
});

function tab(over: Partial<WaitFact> = {}): WaitFact {
	return { tabId: "t1", running: true, awaitingUi: false, awaitingConnection: false, ...over };
}

function entry(at: number, message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message });
}

interface RigOptions {
	facts?: () => Promise<Record<string, unknown>>;
	/** Runs before the first look at the tabs. */
	before?: (watch: TurnWaitWatch) => void;
}

function rig(tabs: WaitFact[], options: RigOptions = {}) {
	const clock = { now: START };
	const lines: Array<Record<string, string | number | boolean>> = [];
	const state = { tabs };
	const firstReport = Promise.withResolvers<void>();
	const watch = new TurnWaitWatch({
		now: () => clock.now,
		tabs: () => state.tabs,
		facts:
			options.facts ??
			(async () => ({
				status: "ready",
				stock: { isStreaming: false, queuedMessageCount: 1, isSettled: false, queuedMessages: { steering: [] } },
				run: { running: true, turn: true },
			})),
		status: () => "restarting",
		journal: journalWait,
		log: details => {
			lines.push(details);
			firstReport.resolve();
		},
	});
	/** A look a minute for `count` minutes, then the lines those looks wrote. */
	const minutes = async (count: number) => {
		for (let index = 0; index < count; index++) {
			clock.now += WAIT_SWEEP_MS;
			watch.sweep();
		}
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
	};
	options.before?.(watch);
	watch.sweep();
	return { clock, lines, state, watch, minutes, reported: firstReport.promise };
}

describe("turn wait watch", () => {
	it("writes a turn without a step once at ten minutes, with its open tool call and what its omp answers", async () => {
		const file = join(dir, "2026-11-20_abc.jsonl");
		const { lines, minutes, reported } = rig([tab({ sessionFile: file })]);
		const journal = [
			entry(START - 5_000, { role: "user", content: "run the build" }),
			entry(START, {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "secret" } },
					{ type: "toolCall", id: "c2", name: "read", arguments: {} },
				],
			}),
			entry(START + 1_000, { role: "toolResult", toolCallId: "c2", content: [] }),
		];
		await writeFile(file, journal.join("\n"));
		await minutes(9);
		expect(lines).toEqual([]);

		await minutes(1);
		await reported;
		expect(lines).toEqual([
			{
				tab: "t1",
				session: "2026-11-20_abc.jsonl",
				on: "turn",
				waitedMs: WAIT_REPORT_MS,
				report: 1,
				tools: "bash",
				toolsMs: WAIT_REPORT_MS,
				journal: "toolResult",
				journalMs: WAIT_REPORT_MS - 1_000,
				omp: "answered",
				status: "ready",
				streaming: false,
				queued: 1,
				settled: false,
			},
		]);
	});

	it("writes again only when the wait has doubled", async () => {
		const { lines, minutes } = rig([tab()]);
		await minutes(19);
		expect(lines.map(line => line.report)).toEqual([1]);
		await minutes(1);
		await minutes(19);
		expect(lines.map(line => [line.report, line.waitedMs])).toEqual([
			[1, WAIT_REPORT_MS],
			[2, WAIT_REPORT_MS * 2],
		]);
		await minutes(1);
		expect(lines.at(-1)).toMatchObject({ report: 3, waitedMs: WAIT_REPORT_MS * 4 });
	});

	it("starts the wait again at a step, and at an answered question", async () => {
		const { lines, watch, minutes } = rig([tab()]);
		await minutes(6);
		watch.activity({ type: "step", tabId: "t1" });
		await minutes(9);
		expect(lines).toEqual([]);
		watch.activity({ type: "askClosed", tabId: "t1", requestId: "r1" });
		await minutes(9);
		expect(lines).toEqual([]);
		await minutes(1);
		expect(lines).toMatchObject([{ report: 1, waitedMs: WAIT_REPORT_MS }]);
	});

	it("keeps one wait through a retry that fails again: a failed run's step is none", async () => {
		const failed = { stopReason: "error", errorMessage: "429 rate_limit_error" };
		const { lines, state, watch, minutes } = rig([tab({ running: false })], {
			before: armed => armed.noteRetry("t1", { at: START + 9 * 60_000, attempt: 3 }),
		});
		await minutes(9);
		// The retry fires; its reply fails, and that reply's end is announced as a step before the run ends.
		watch.noteRetry("t1", undefined);
		state.tabs = [tab()];
		watch.activity({ type: "busy", tabId: "t1" });
		watch.activity({ type: "step", tabId: "t1" });
		watch.activity({ type: "idle", tabId: "t1", outcome: failed });
		state.tabs = [tab({ running: false, lastRun: failed })];
		watch.noteRetry("t1", { at: START + 20 * 60_000, attempt: 4 });
		await minutes(1);
		expect(lines).toEqual([
			{
				tab: "t1",
				on: "retry",
				waitedMs: WAIT_REPORT_MS,
				report: 1,
				retryAt: "2026-11-20T00:20:00.000Z",
				attempt: 4,
				lastStop: "error",
				lastError: "429 rate_limit_error",
				omp: "answered",
				status: "ready",
				streaming: false,
				queued: 1,
				settled: false,
			},
		]);
	});

	it("names a provider's limit with its until, and an omp that does not answer", async () => {
		const { lines, minutes } = rig([tab({ running: false })], {
			before: armed => armed.noteRetry("t1", { at: START + 18 * HOUR, attempt: 1, limit: true }),
			facts: async () => {
				throw new Error("omp did not answer get_state in time");
			},
		});
		await minutes(10);
		expect(lines).toEqual([
			{
				tab: "t1",
				on: "limit",
				waitedMs: WAIT_REPORT_MS,
				report: 1,
				retryAt: "2026-11-20T18:00:00.000Z",
				attempt: 1,
				omp: "no answer: omp did not answer get_state in time",
				status: "restarting",
			},
		]);
	});

	it("tells the computer's sleep from the wait: a line is due by the time awake", async () => {
		const { clock, lines, minutes } = rig([tab()]);
		await minutes(4);
		clock.now += 8 * HOUR;
		await minutes(5);
		expect(lines).toEqual([]);
		await minutes(1);
		expect(lines).toMatchObject([{ report: 1, waitedMs: WAIT_REPORT_MS + 8 * HOUR, asleepMs: 8 * HOUR }]);
	});

	it("writes nothing for a tab that stopped waiting, and starts over for one that was closed", async () => {
		const { lines, state, watch, minutes } = rig([tab(), tab({ tabId: "t2" })]);
		await minutes(9);
		state.tabs = [tab({ running: false }), tab({ tabId: "t2" })];
		watch.activity({ type: "released", tabId: "t2" });
		await minutes(5);
		expect(lines).toEqual([]);
	});

	it("skips a look while the core cannot answer", () => {
		const watch = new TurnWaitWatch({
			tabs: () => {
				throw new Error("ompdesk-core is shutting down");
			},
			facts: async () => ({}),
			status: () => undefined,
			journal: journalWait,
			log: () => {},
		});
		expect(() => watch.sweep()).not.toThrow();
	});
});

describe("waitsOn", () => {
	it("names every wait, the most telling first", () => {
		expect(waitsOn(tab({ running: false }), undefined, false)).toEqual([]);
		expect(waitsOn(tab(), undefined, false)).toEqual(["turn"]);
		expect(waitsOn(tab({ settling: true }), undefined, false)).toEqual(["background"]);
		expect(waitsOn(tab({ awaitingUi: true }), undefined, false)).toEqual(["ask", "turn"]);
		expect(waitsOn(tab({ running: false, awaitingConnection: true }), { at: 1, attempt: 2 }, true)).toEqual([
			"connection",
			"retry",
			"resuming",
		]);
		expect(waitsOn(tab({ retry: { errorMessage: "socket closed" } }), undefined, false)).toEqual([
			"stock-retry",
			"turn",
		]);
	});

	it("reads a hosted tab's held waits, never its running turn", () => {
		expect(waitsOn(tab({ peer: "phone" }), undefined, false)).toEqual([]);
		expect(waitsOn(tab({ peer: "phone", awaitingUi: true }), { at: 1, attempt: 1, limit: true }, false)).toEqual([
			"ask",
			"limit",
		]);
	});
});

describe("journalWait", () => {
	it("names the last reply's calls without a result, and none once a prompt followed", async () => {
		const file = join(dir, "prompt.jsonl");
		const reply = entry(START, {
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "on it" },
				{ type: "toolCall", id: "a", name: "task" },
				{ type: "toolCall", id: "b", name: "wait" },
			],
		});
		await writeFile(file, ['{"type":"mess', reply].join("\n"));
		expect(await journalWait(file, START + 60_000)).toEqual({
			tools: "task, wait",
			toolsMs: 60_000,
			journal: "assistant/toolUse",
			journalMs: 60_000,
		});
		const prompt = entry(START + 30_000, { role: "user", content: "stop that" });
		await writeFile(file, [reply, prompt].join("\n"));
		expect(await journalWait(file, START + 60_000)).toEqual({ journal: "user", journalMs: 30_000 });
		await writeFile(file, "");
		expect(await journalWait(file, START)).toEqual({});
		expect(await journalWait(join(dir, "missing.jsonl"), START)).toEqual({});
	});

	it("counts only nonempty lines toward 400 and discards the first byte-limited fragment even at a newline", async () => {
		const file = join(dir, "bounded.jsonl");
		const prompt = entry(START, { role: "user" });
		const read = async (text: string) => {
			await writeFile(file, text);
			return journalWait(file, START);
		};
		expect(await read(`${prompt}\n${" \n\n".repeat(399)}`)).toEqual({ journal: "user", journalMs: 0 });
		expect(await read(`${prompt}\n${" \n\n".repeat(400)}`)).toEqual({});
		const window = `${prompt}\n`.padEnd(1024 * 1024, "\n");
		expect(await read(window)).toEqual({ journal: "user", journalMs: 0 });
		expect(await read(`\n${window}`)).toEqual({});
	});

	it("keeps escaped tool ids distinct, ignores call arguments and uses the runtime's date parser", async () => {
		const file = join(dir, "restored.jsonl");
		const reply = entry(START, {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "\ud800", name: "\ud800" },
				{ type: "toolCall", id: "\ud801", name: "read", arguments: { token: "private" } },
			],
		});
		const result = JSON.stringify({
			type: "message",
			timestamp: "Fri, 20 Nov 2026 00:00:02 GMT",
			message: { role: "toolResult", toolCallId: "\ud801" },
		});
		await writeFile(file, [reply, result].join("\n"));
		expect(await journalWait(file, START)).toEqual({
			tools: "\ud800",
			toolsMs: 0,
			journal: "toolResult",
			journalMs: -2000,
		});
	});
});
