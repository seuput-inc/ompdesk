/**
 * A terminal viewport's read loop (design §7.2), a desktop window's and a web viewer's alike: it asks once and the
 * host holds the answer until the PTY writes or changes (at most 1 s, `waitMs`), so an idle shell costs one request a
 * second (the desktop used to ask every 80 ms). The viewer's next request is also its acknowledgement: it is made only
 * after xterm has taken the last output (`write` resolves when xterm has parsed it), carrying the offset the viewer has
 * reached, and the host cuts each answer to an output budget (64 KB), so a runaway program feeds the screen as fast as
 * it can draw, never faster.
 *
 * A host that predates the long poll answers at once with nothing new; `MIN_GAP_MS` keeps that from becoming a
 * busy loop.
 *
 * xterm parses its writes in order. An answer it has not taken after `WRITE_CHECK_MS` gets an empty write queued
 * behind it (`probe`): when that one comes back, xterm took the output and only its callback was lost, so the read
 * goes on from the answer's offset; when neither comes back within another `WRITE_CHECK_MS`, the parser is stuck and
 * the read stops (`wedged`). Nothing is judged while the page is hidden, where timers are throttled (U172).
 */
import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_POLL_MAX_WAIT_MS,
	type TerminalOperation,
	type TerminalSnapshot,
} from "../../shared/terminal-types";

/** The shortest an empty answer may take before the next request goes out (80 ms, the old desktop poll's period). */
export const MIN_GAP_MS = 80;
/** Pause after a failed request before asking again. */
export const RETRY_MS = 1000;
/** How long xterm may take with one answer before the read checks whether it still parses. */
export const WRITE_CHECK_MS = 10_000;

export interface TerminalPollOptions {
	id: string;
	/** One terminal operation, or null when the request failed (the caller has shown the error). */
	request(operation: TerminalOperation): Promise<TerminalSnapshot[] | null>;
	/** Give xterm `output`; resolves when xterm has parsed it. The next request waits for it. */
	write(output: string): Promise<void>;
	/** A snapshot of the session arrived (exit state, size, lease). */
	onSnapshot(snapshot: TerminalSnapshot): void;
	stopped(): boolean;
	/**
	 * The answer starts past a cut (`gap`: the viewer fell more than the kept scrollback behind, or the stream's head
	 * was cut before it came): called before its output is written, so the screen starts clean instead of continuing a
	 * stream with a hole in it (H139).
	 */
	reset?(): void;
	/**
	 * The first answer with nothing new after a gap: the replay has settled. The viewport asks the program to redraw if
	 * its screen is still blank (H137).
	 */
	settled?(): void;
	/** Resolves when xterm has parsed an empty write queued now, so everything written before it (U172). */
	probe?(): Promise<void>;
	/** The page is hidden (its timers are throttled, so a slow write proves nothing). */
	hidden?(): boolean;
	/**
	 * xterm took neither an answer nor the probe behind it in time: its parser is stuck. The read has stopped; the
	 * viewport replaces the screen with a new one, which reads the kept scrollback from its start (U172).
	 */
	wedged?(): void;
	/** Where the stream starts (0 reads the whole scrollback). */
	offset?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};

/** Whether `work` settles within `ms`. */
function within(ms: number, work: Promise<unknown>): Promise<boolean> {
	const { promise: late, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(resolve, ms, false);
	return Promise.race([work.then(() => true), late]).finally(() => clearTimeout(timer));
}

/** Writes `output` to xterm; false when its parser stopped taking writes (see the file's comment). */
async function parsed(options: TerminalPollOptions, output: string): Promise<boolean> {
	const written = options.write(output);
	const { probe } = options;
	if (!probe) {
		await written;
		return true;
	}
	while (!options.stopped()) {
		if (await within(WRITE_CHECK_MS, written)) return true;
		if (options.hidden?.()) continue;
		if (await within(WRITE_CHECK_MS, Promise.race([written, probe()]))) return true;
		if (!options.hidden?.()) return false;
	}
	return true;
}

/** Read `id` until `stopped()`. Never has more than one request in flight. */
export async function pollTerminal(options: TerminalPollOptions): Promise<void> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? realSleep;
	let offset = options.offset ?? 0;
	let afterGap = false;
	while (!options.stopped()) {
		const started = now();
		const snapshots = await options.request({
			action: "list",
			offsets: { [options.id]: offset },
			waitMs: TERMINAL_POLL_MAX_WAIT_MS,
			budget: TERMINAL_OUTPUT_BUDGET,
		});
		if (options.stopped()) return;
		if (!snapshots) {
			await sleep(RETRY_MS);
			continue;
		}
		const snapshot = snapshots.find(item => item.id === options.id);
		if (!snapshot) {
			// The session is gone (closed elsewhere): nothing to read; the panel's own list shows it.
			await sleep(RETRY_MS);
			continue;
		}
		options.onSnapshot(snapshot);
		if (snapshot.gap) {
			options.reset?.();
			afterGap = true;
		}
		if (snapshot.output) {
			// The acknowledgement: asking again only once xterm has the output.
			if (!(await parsed(options, snapshot.output))) {
				options.wedged?.();
				return;
			}
			offset = snapshot.offset;
			continue;
		}
		offset = snapshot.offset;
		if (afterGap) {
			afterGap = false;
			options.settled?.();
		}
		const took = now() - started;
		if (took < MIN_GAP_MS) await sleep(MIN_GAP_MS - took);
	}
}
