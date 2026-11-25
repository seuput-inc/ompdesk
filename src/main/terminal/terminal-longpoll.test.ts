/**
 * A terminal viewport's poll (design §7.2), a desktop window's and a web viewer's: `list` with `waitMs` is held in the
 * stock helper's service until a session has output past the viewer's offset, exits, changes what a viewer shows
 * (size, restart, close, clear, a claim of the size), or the hold ends; `budget` cuts one reply and the offset it
 * returns is where the cut fell, so the viewer's next request (its acknowledgement) reads on from there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Pty,
	type PtyOptions,
	TerminalService,
} from "../../../resources/gui-bridge/stock-helper/terminal-service";
import { TERMINAL_OUTPUT_BUDGET, TERMINAL_POLL_MAX_WAIT_MS } from "../../shared/terminal-types";
import { validTerminalOperation } from "./requests";

const options: PtyOptions = { application: "/bin/zsh", args: ["-l"], cwd: "/project", env: {}, cols: 80, rows: 24 };

function fixture() {
	const chunks: Array<(error: Error | null, text: string) => void> = [];
	const exits: Array<(value: { exitCode?: number }) => void> = [];
	const service = new TerminalService(
		() =>
			({
				startArgv: (_options, onChunk) => {
					chunks.push(onChunk);
					const done = Promise.withResolvers<{ exitCode?: number }>();
					exits.push(done.resolve);
					return done.promise;
				},
				write: vi.fn(),
				resize: vi.fn(),
				kill: vi.fn(),
			}) satisfies Pty,
	);
	const [session] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
	if (!session) throw new Error("no session");
	return { service, id: session.id, chunk: chunks[0]!, exit: exits[0]! };
}

describe("terminal long poll", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("holds an idle poll for the wait and then answers with nothing new", async () => {
		const { service, id } = fixture();
		let answered = false;
		const reply = service.wait("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 }).then(() => {
			answered = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		await reply;
		expect(answered).toBe(true);
	});

	it("answers the moment the PTY writes, long before the hold ends", async () => {
		const { service, id, chunk } = fixture();
		const reply = service.wait("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 });
		await vi.advanceTimersByTimeAsync(40);
		chunk(null, "hello\r\n");
		await reply;
		expect(service.request("tab", { action: "list" }, options)[0]).toMatchObject({ delta: "hello\r\n", offset: 7 });
		// No timer is left behind: the hold's own timeout was cleared.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("answers at once when output is already waiting past the offset", async () => {
		const { service, id, chunk } = fixture();
		chunk(null, "abc");
		await service.wait("tab", { action: "list", offsets: { [id]: 1 }, waitMs: 1000 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("wakes for an exit, so the viewer learns the shell is gone", async () => {
		const { service, id, exit } = fixture();
		const reply = service.wait("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 });
		exit({ exitCode: 2 });
		await reply;
		const [snapshot] = service.request("tab", { action: "list" }, options);
		expect(snapshot).toMatchObject({ exited: true, exitCode: 2 });
	});

	it("wakes another window's poll when one resizes or claims the PTY, so it follows the new size at once", async () => {
		const { service, id } = fixture();
		const resized = service.wait("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 });
		service.request("tab", { action: "resize", id, cols: 120, rows: 40 }, options);
		await resized;
		expect(service.request("tab", { action: "list" }, options)[0]).toMatchObject({ id, cols: 120, rows: 40 });
		const claimed = service.wait("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 });
		// A claim answers as a list (no output) and is no error, even for a session already gone.
		expect(service.request("tab", { action: "claim", id: "gone" }, options)).toEqual([
			expect.objectContaining({ id, offset: 0 }),
		]);
		await claimed;
		// No hold's timer is left; the one left is the silent shell's startup-input wait (`SHELL_READY_MS`).
		expect(vi.getTimerCount()).toBe(1);
	});

	it("a session the viewer has no offset for is no news: the hold runs its length", async () => {
		const { service, chunk } = fixture();
		chunk(null, "x");
		let answered = false;
		void service.wait("tab", { action: "list", offsets: {}, waitMs: 1000 }).then(() => {
			answered = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		// Nothing was past an offset, so it waited out the hold (a viewer with no offsets is only asking what exists).
		expect(answered).toBe(true);
	});
});

describe("terminal list validation", () => {
	it("accepts a wait up to one second and a budget up to the cap, and refuses more", () => {
		expect(validTerminalOperation({ action: "list", offsets: { a: 0 }, waitMs: TERMINAL_POLL_MAX_WAIT_MS })).toBe(
			true,
		);
		expect(validTerminalOperation({ action: "list", waitMs: TERMINAL_POLL_MAX_WAIT_MS + 1 })).toBe(false);
		expect(validTerminalOperation({ action: "list", waitMs: -1 })).toBe(false);
		expect(validTerminalOperation({ action: "list", budget: TERMINAL_OUTPUT_BUDGET })).toBe(true);
		expect(validTerminalOperation({ action: "list", budget: TERMINAL_OUTPUT_BUDGET + 1 })).toBe(false);
		expect(validTerminalOperation({ action: "list", budget: 0 })).toBe(false);
		expect(validTerminalOperation({ action: "claim", id: "a" })).toBe(true);
		expect(validTerminalOperation({ action: "claim" } as never)).toBe(false);
	});
});
