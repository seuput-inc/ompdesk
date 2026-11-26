/**
 * A test process whose thread is held by a synchronous call says which test and step held it, and ends.
 *
 * Why: Vitest's test and hook timeouts are timers on the test's own thread, so a call that never returns there (an
 * `execFileSync` whose child's pipe another process still holds) outlasts every timeout. The file never reports and
 * the CI job runs into its limit with nothing naming the test (win-platform 1/3 on 26 Nov 2026: runs 45780054382,
 * 45787638027, 45791480854 and 45796773006 each cancelled after 20 min with no line for
 * `src/main/autopilot-restart-resume.test.ts`). A thread of its own sees the test thread stop beating, writes the
 * test and the synchronous step it was in to stderr, and ends the process, so Vitest fails that file and goes on.
 *
 * `watchBlockedThread` is wired from `vitest.setup.ts` for the node project (a `forks` worker, whose test thread is the
 * process's main thread); `blockingStep` is what a synchronous helper wraps its call in (`gitSync`).
 */
import { url as inspectorUrl } from "node:inspector";
import { isMainThread, Worker } from "node:worker_threads";

/** How long the test thread may not beat before the process ends: far past any test's own timeout. */
export const BLOCKED_LIMIT_MS = 180_000;
const BEAT_MS = 1_000;
const TEXT_BYTES = 1_024;
/** Int32 slots: the beat count, then the byte lengths of the two texts. */
const BEAT = 0;
const TEST_LENGTH = 1;
const STEP_LENGTH = 2;
const HEADER_BYTES = 3 * 4;

interface Watch {
	header: Int32Array;
	test: Uint8Array;
	step: Uint8Array;
}

// One watch per process: Vitest evaluates the setup file again in every test file's module graph.
const KEY = Symbol.for("ompdesk.vitest-block-watch");
const holder = globalThis as { [KEY]?: Watch };

const WATCHER = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const header = new Int32Array(workerData.shared, 0, 3);
const text = (offset, length) => Buffer.from(workerData.shared, offset, length).toString("utf8");
let last = Atomics.load(header, 0);
let since = Date.now();
setInterval(() => {
	const beat = Atomics.load(header, 0);
	if (beat !== last) {
		last = beat;
		since = Date.now();
		return;
	}
	const held = Date.now() - since;
	if (held < workerData.limit) return;
	const test = text(${HEADER_BYTES}, Atomics.load(header, 1)) || "(no test started)";
	const step = text(${HEADER_BYTES + TEXT_BYTES}, Atomics.load(header, 2));
	writeSync(2, "[block-watch] " + test + ": the test thread did not run for " + Math.round(held / 1000) + " s" +
		(step ? "; it was in " + step : "; no synchronous step was noted") + ". Ending this test process.\\n");
	process.kill(process.pid, "SIGKILL");
}, ${BEAT_MS});
`;

function write(watch: Watch, slot: number, target: Uint8Array, text: string): void {
	const { written } = new TextEncoder().encodeInto(text, target);
	Atomics.store(watch.header, slot, written);
}

/**
 * Starts the watch once per process: on the process's main thread only (a `threads` worker's thread is not the
 * process, so ending the process would end the whole run), and not while a debugger may hold the thread on purpose.
 */
export function watchBlockedThread(limitMs = BLOCKED_LIMIT_MS): void {
	if (!isMainThread || holder[KEY] || inspectorUrl()) return;
	const shared = new SharedArrayBuffer(HEADER_BYTES + 2 * TEXT_BYTES);
	const watch: Watch = {
		header: new Int32Array(shared, 0, 3),
		test: new Uint8Array(shared, HEADER_BYTES, TEXT_BYTES),
		step: new Uint8Array(shared, HEADER_BYTES + TEXT_BYTES, TEXT_BYTES),
	};
	holder[KEY] = watch;
	// A count, not a time: a test's fake timers move Date, never this.
	setInterval(() => Atomics.add(watch.header, BEAT, 1), BEAT_MS).unref();
	new Worker(WATCHER, { eval: true, name: "vitest-block-watch", workerData: { shared, limit: limitMs } }).unref();
}

/** The test now running, as the report names it. */
export function watchedTest(name: string): void {
	const watch = holder[KEY];
	if (watch) write(watch, TEST_LENGTH, watch.test, name);
}

/** Runs `call` as the step a report names should the thread not come back from it. */
export function blockingStep<T>(step: string, call: () => T): T {
	const watch = holder[KEY];
	if (!watch) return call();
	write(watch, STEP_LENGTH, watch.step, step);
	try {
		return call();
	} finally {
		Atomics.store(watch.header, STEP_LENGTH, 0);
	}
}
