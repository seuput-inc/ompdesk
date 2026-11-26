import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NUDGE_MS,
	type Pty,
	type PtyOptions,
	restoredSeparator,
	SHELL_READY_MS,
	TerminalService,
} from "../../../resources/gui-bridge/stock-helper/terminal-service";

const options: PtyOptions = {
	application: "/bin/zsh",
	args: ["-l"],
	cwd: "/project",
	env: { PATH: "/bin" },
	cols: 80,
	rows: 24,
};
function fixture(
	cwdOf?: (pid: number) => Promise<string | null>,
	runningUnder?: (pid: number) => Promise<boolean | null>,
) {
	const processes: Array<{
		pty: Pty;
		done: { resolve: (value: { exitCode?: number }) => void };
		chunk: (error: Error | null, text: string) => void;
	}> = [];
	const service = new TerminalService(
		() => {
			const done = Promise.withResolvers<{ exitCode?: number }>();
			const pid = 4001 + processes.length;
			const entry = {
				pty: {
					startArgv: vi.fn((_options: PtyOptions, chunk: (error: Error | null, text: string) => void) => {
						entry.chunk = chunk;
						return done.promise;
					}),
					write: vi.fn(),
					resize: vi.fn(),
					kill: vi.fn(),
					pid: () => pid,
				},
				done,
				chunk: (_error: Error | null, _text: string) => {},
			};
			processes.push(entry);
			return entry.pty;
		},
		cwdOf,
		runningUnder,
	);
	return { service, processes };
}
describe("stock terminal lifecycle", () => {
	it("spawns the login shell in the tab cwd, streams, writes, resizes and reports exit", async () => {
		const { service, processes } = fixture();
		const [session] = service.request("tab", { action: "create", cols: 90, rows: 30 }, options);
		expect(processes[0].pty.startArgv).toHaveBeenCalledWith({ ...options, cols: 90, rows: 30 }, expect.any(Function));
		processes[0].chunk(null, "ompdesk-term\r\n");
		const [snapshot] = service.request("tab", { action: "list" }, options);
		expect(snapshot.delta).toBe("ompdesk-term\r\n");
		expect(service.request("tab", { action: "list" }, options)[0].delta).toBeUndefined();
		service.request("tab", { action: "write", id: session.id, data: "echo hello\r" }, options);
		expect(processes[0].pty.write).toHaveBeenCalledWith("echo hello\r");
		service.request("tab", { action: "resize", id: session.id, cols: 100, rows: 40 }, options);
		expect(processes[0].pty.resize).toHaveBeenCalledWith(100, 40);
		processes[0].done.resolve({ exitCode: 3 });
		await Promise.resolve();
		expect(service.request("tab", { action: "list" }, options)[0]).toMatchObject({ exited: true, exitCode: 3 });
	});
	it("kills on close, tab disposal and app disposal, and isolates owners", () => {
		const { service, processes } = fixture();
		const [one] = service.request("one", { action: "create", cols: 80, rows: 24 }, options);
		service.request("two", { action: "create", cols: 80, rows: 24 }, options);
		expect(() => service.request("two", { action: "write", id: one.id, data: "x" }, options)).toThrow(
			"Terminal not found",
		);
		service.request("one", { action: "close", id: one.id }, options);
		expect(processes[0].pty.kill).toHaveBeenCalledOnce();
		service.dispose("two");
		expect(processes[1].pty.kill).toHaveBeenCalledOnce();
		service.request("three", { action: "create", cols: 80, rows: 24 }, options);
		service.dispose();
		expect(processes[2].pty.kill).toHaveBeenCalledOnce();
	});
	it("restarts with the resized geometry and ignores stale exit callbacks", async () => {
		const { service, processes } = fixture();
		const [one] = service.request("one", { action: "create", cols: 80, rows: 24 }, options);
		service.request("one", { action: "resize", id: one.id, cols: 110, rows: 50 }, options);
		service.request("one", { action: "restart", id: one.id }, options);
		processes[0].done.resolve({ exitCode: 9 });
		await Promise.resolve();
		expect(service.request("one", { action: "list" }, options)[0].exited).toBe(false);
		expect(processes[1].pty.startArgv).toHaveBeenCalledWith(
			{ ...options, cols: 110, rows: 50 },
			expect.any(Function),
		);
		processes[1].chunk(null, "hello");
		service.request("one", { action: "clear", id: one.id }, options);
		expect(service.request("one", { action: "list" }, options)[0]).toMatchObject({ offset: 5, delta: undefined });
	});
	it("restarts and closes an exited stock PTY without calling its invalid kill operation", async () => {
		const { service, processes } = fixture();
		const [one] = service.request("one", { action: "create", cols: 80, rows: 24 }, options);
		processes[0].done.resolve({ exitCode: 0 });
		await Promise.resolve();
		vi.mocked(processes[0].pty.kill).mockImplementation(() => {
			throw new Error("PTY session is not running");
		});
		service.request("one", { action: "restart", id: one.id }, options);
		expect(processes[0].pty.kill).not.toHaveBeenCalled();
		processes[1].done.resolve({ exitCode: 0 });
		await Promise.resolve();
		vi.mocked(processes[1].pty.kill).mockImplementation(() => {
			throw new Error("PTY session is not running");
		});
		expect(service.request("one", { action: "close", id: one.id }, options)).toEqual([]);
		expect(processes[1].pty.kill).not.toHaveBeenCalled();
	});
	it("names a terminal by its shell, then by the name a person gave it, for every viewer (Orca FT2/FT8)", () => {
		const { service } = fixture();
		const [made] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		expect(made).toMatchObject({ shell: "zsh" });
		expect(made?.title).toBeUndefined();
		service.request("tab", { action: "rename", id: made.id, title: "  api server " }, options);
		expect(service.request("tab", { action: "list" }, options)[0]).toMatchObject({ title: "api server" });
		service.request("tab", { action: "rename", id: made.id, title: "" }, options);
		expect(service.request("tab", { action: "list" }, options)[0]?.title).toBeUndefined();
	});
	it("says whether a command runs: from the shell's process, never for an ended one, unknown when unreadable (FT22)", async () => {
		const running = vi.fn(async (pid: number) => (pid === 4001 ? true : null));
		const { service, processes } = fixture(undefined, running);
		const [first] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		const [, second] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		expect(await service.busy("tab", first.id)).toBe(true);
		expect(await service.busy("tab", second.id)).toBeNull();
		processes[0].done.resolve({ exitCode: 0 });
		await Promise.resolve();
		expect(await service.busy("tab", first.id)).toBe(false);
		await expect(service.busy("other", second.id)).rejects.toThrow("Terminal not found");
	});
});

describe("terminal startup input (D90)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});
	it("holds what is typed before the shell first writes and sends it, in order, with that output", () => {
		const { service, processes } = fixture();
		const [one] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		service.request("tab", { action: "write", id: one.id, data: "cd src\r" }, options);
		service.request("tab", { action: "write", id: one.id, data: "ls\r" }, options);
		expect(processes[0].pty.write).not.toHaveBeenCalled();
		processes[0].chunk(null, "$ ");
		expect(vi.mocked(processes[0].pty.write).mock.calls).toEqual([["cd src\r"], ["ls\r"]]);
		service.request("tab", { action: "write", id: one.id, data: "pwd\r" }, options);
		expect(processes[0].pty.write).toHaveBeenLastCalledWith("pwd\r");
	});
	it("sends the held input after 15 s when the shell stays silent, and drops it for a shell that ended", async () => {
		vi.useFakeTimers();
		const { service, processes } = fixture();
		const [quiet] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		const [, ended] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		service.request("tab", { action: "write", id: quiet.id, data: "x" }, options);
		service.request("tab", { action: "write", id: ended.id, data: "y" }, options);
		processes[1].done.resolve({ exitCode: 1 });
		await vi.advanceTimersByTimeAsync(SHELL_READY_MS - 1);
		expect(processes[0].pty.write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(processes[0].pty.write).toHaveBeenCalledWith("x");
		expect(processes[1].pty.write).not.toHaveBeenCalled();
	});
});

describe("terminal history across a restart (D92)", () => {
	it("checkpoints a session's changed terminals with their unread output and the shell's folder now", async () => {
		const { service, processes } = fixture(async pid => (pid === 4001 ? "/project/src" : null));
		const [kept] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options, "/s/a.jsonl");
		service.request("other", { action: "create", cols: 80, rows: 24 }, options, "");
		processes[0].chunk(null, "built\r\n$ ");
		processes[1].chunk(null, "not kept");
		const first = await service.checkpoints({});
		expect(first.save).toEqual([
			{
				session: "/s/a.jsonl",
				id: kept.id,
				order: expect.any(Number),
				cwd: "/project/src",
				shell: "/bin/zsh",
				exited: false,
			},
		]);
		// The core's scrollback, which writes the history, gets the output no viewer has read yet.
		expect(first.rows).toEqual([expect.objectContaining({ id: kept.id, delta: "built\r\n$ ", offset: 9 })]);
		expect(await service.checkpoints({})).toEqual({ rows: [], save: [] });
		expect((await service.checkpoints({ all: true })).save.map(item => item.id)).toEqual([kept.id]);
		processes[0].chunk(null, "more");
		expect((await service.checkpoints({})).rows).toEqual([expect.objectContaining({ delta: "more", offset: 13 })]);
		// A tab left for no session file stops keeping its terminals.
		service.request("tab", { action: "list" }, options, "");
		expect(await service.checkpoints({ all: true })).toEqual({ rows: [], save: [] });
	});
	it("brings a saved terminal back under its id: old output, the restored line, a new shell in its folder", () => {
		const { service, processes } = fixture();
		service.restore(
			"tab",
			"/s/a.jsonl",
			[
				{
					id: "saved-1",
					order: 1,
					history: "old output\r\n",
					exited: false,
					options: { ...options, cwd: "/project/src" },
				},
			],
			"Restored",
		);
		expect(processes[0].pty.startArgv).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/project/src" }),
			expect.any(Function),
		);
		processes[0].chunk(null, "$ ");
		const [snapshot] = service.request("tab", { action: "list" }, options);
		const output = `old output\r\n${restoredSeparator("Restored")}$ `;
		expect(snapshot).toMatchObject({ id: "saved-1", exited: false, delta: output, offset: output.length });
	});
	it("brings a terminal that had ended back ended, with no shell started (P107)", () => {
		const { service, processes } = fixture();
		service.restore(
			"tab",
			"/s/a.jsonl",
			[{ id: "gone", order: 1, history: "bye\r\n", exited: true, error: "spawn failed", options }],
			"Restored",
		);
		expect(processes[0].pty.startArgv).not.toHaveBeenCalled();
		expect(service.request("tab", { action: "list" }, options)[0]).toMatchObject({
			id: "gone",
			exited: true,
			error: "spawn failed",
			delta: "bye\r\n",
		});
		expect(service.dispose("tab")).toEqual(["gone"]);
		expect(processes[0].pty.kill).not.toHaveBeenCalled();
	});
});

describe("a blank screen after the cut, and a failed restart (DP4)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});
	it("redraws only when a viewer asks: one row shorter, then back after 250 ms, one at a time (H137)", async () => {
		vi.useFakeTimers();
		const { service, processes } = fixture();
		const [one] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		service.request("tab", { action: "list", offsets: { [one.id]: 0 } }, options);
		expect(processes[0].pty.resize).not.toHaveBeenCalled();
		service.request("tab", { action: "redraw", id: one.id }, options);
		service.request("tab", { action: "redraw", id: one.id }, options);
		expect(vi.mocked(processes[0].pty.resize).mock.calls).toEqual([[80, 23]]);
		await vi.advanceTimersByTimeAsync(NUDGE_MS);
		expect(vi.mocked(processes[0].pty.resize).mock.calls).toEqual([
			[80, 23],
			[80, 24],
		]);
	});
	it("keeps a restart that failed failed: nothing starts again until the person restarts (P107)", () => {
		const started: string[] = [];
		let attempts = 0;
		const service = new TerminalService(() => {
			attempts += 1;
			const attempt = attempts;
			return {
				startArgv: () => {
					started.push(`start ${attempt}`);
					if (attempt > 1) throw new Error("spawn failed");
					return Promise.withResolvers<{ exitCode?: number }>().promise;
				},
				write: vi.fn(),
				resize: vi.fn(),
				kill: vi.fn(),
			};
		});
		const [one] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
		service.request("tab", { action: "restart", id: one.id }, options);
		for (let poll = 0; poll < 3; poll += 1)
			expect(service.request("tab", { action: "list", offsets: { [one.id]: 0 } }, options)[0]).toMatchObject({
				exited: true,
				error: "spawn failed",
			});
		service.request("tab", { action: "write", id: one.id, data: "ls\r" }, options);
		service.request("tab", { action: "redraw", id: one.id }, options);
		expect(started).toEqual(["start 1", "start 2"]);
	});
});
