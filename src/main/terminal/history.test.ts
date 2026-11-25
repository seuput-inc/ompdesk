/**
 * Side-panel terminals across a restart (D92) as main runs them: a tab's first terminal request brings its session's
 * saved terminals back, checkpoint passes run while terminals live, a quit takes one last pass and keeps every
 * history, and a request that was on its way when its tab closed leaves no terminal (P89). The core's reader writes
 * and removes the files (`stock/scrollback.rs`, tested in Rust).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalCheckpoint, TerminalSnapshot } from "../../shared/terminal-types";
import { CHECKPOINT_MS, configureTerminalHistory, HOLD_MS, saveTerminalsForQuit } from "./history";
import { disposeTerminals, terminalRequest } from "./requests";

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
const helper: Array<{ method: string; params: Record<string, unknown> }> = [];
let saved: TerminalCheckpoint[] = [];
/** What the worker answers each method; a function is called with the params. */
const answers = new Map<string, (params: Record<string, unknown>) => unknown>();

vi.mock("../core/process", () => ({
	core: () => ({
		call: async (method: string, params: Record<string, unknown>) => {
			calls.push({ method, params });
			return { result: method === "terminalHistory.list" ? saved : null };
		},
	}),
}));
vi.mock("../stock-helper", () => ({
	stockHelperRequest: async (method: string, params: Record<string, unknown>) => {
		helper.push({ method, params });
		const answer = answers.get(method);
		return answer ? answer(params) : [];
	},
}));
vi.mock("./shells", () => ({
	detectShells: async () => [{ path: "/bin/zsh", args: ["-l"], name: "zsh" }],
}));

const checkpoint = (id: string, history = "out"): TerminalCheckpoint => ({
	session: "/s/a.jsonl",
	id,
	order: 1,
	cwd: "/project",
	shell: "/bin/zsh",
	exited: false,
	history,
});
const list = { action: "list", offsets: {} } as const;
let owner = 0;
/** A fresh owner per test: requests.ts restores each owner once per launch. */
const nextOwner = () => `win:${++owner}`;
/** Runs what the requests started (promises and zero timers) on the fake clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const asked = (method: string) => helper.filter(call => call.method === method).map(call => call.params);

describe("terminal history", () => {
	beforeEach(() => {
		calls.length = 0;
		helper.length = 0;
		saved = [];
		answers.clear();
		vi.useFakeTimers();
		configureTerminalHistory({ userData: "/user", notice: () => "Restored after a restart" });
	});
	afterEach(() => {
		configureTerminalHistory(null);
		vi.useRealTimers();
	});

	it("brings a tab's saved terminals back once, in the saved shell, before its first request", async () => {
		saved = [checkpoint("t1", "old")];
		const tab = nextOwner();
		await terminalRequest(tab, "/project", list, { A: "1" }, undefined, "/s/a.jsonl");
		await terminalRequest(tab, "/project", list, { A: "1" }, undefined, "/s/a.jsonl");
		expect(calls.filter(call => call.method === "terminalHistory.list")).toEqual([
			{ method: "terminalHistory.list", params: { userData: "/user", session: "/s/a.jsonl" } },
		]);
		expect(asked("terminal.restore")).toEqual([
			expect.objectContaining({
				owner: tab,
				session: "/s/a.jsonl",
				userData: "/user",
				notice: "Restored after a restart",
				terminals: [
					expect.objectContaining({
						id: "t1",
						history: "old",
						cwd: "/project",
						shell: expect.objectContaining({ path: "/bin/zsh" }),
					}),
				],
			}),
		]);
		expect(helper.findIndex(call => call.method === "terminal.restore")).toBeLessThan(
			helper.findIndex(call => call.method === "terminal.request"),
		);
		expect(asked("terminal.request")[0]).toMatchObject({ session: "/s/a.jsonl" });
	});

	it("tells the worker a tab has no session file, and restores nothing for it", async () => {
		await terminalRequest(nextOwner(), "/project", list, {}, undefined, null);
		expect(calls).toEqual([]);
		expect(asked("terminal.request")).toEqual([expect.objectContaining({ session: "" })]);
	});

	it("asks the worker for checkpoints while a session's terminals live, resting between passes", async () => {
		const passes: Array<() => void> = [];
		answers.set("terminal.checkpoints", () => {
			const pass = Promise.withResolvers<void>();
			passes.push(pass.resolve);
			return pass.promise;
		});
		await terminalRequest(nextOwner(), "/project", list, {}, undefined, "/s/a.jsonl");
		await settle();
		expect(asked("terminal.checkpoints")).toEqual([{ userData: "/user", waitMs: HOLD_MS }]);
		passes.shift()?.();
		await vi.advanceTimersByTimeAsync(CHECKPOINT_MS - 1);
		expect(asked("terminal.checkpoints")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(asked("terminal.checkpoints")).toHaveLength(2);
	});

	it("takes a last pass over every terminal at a quit and keeps their history while the tabs go", async () => {
		answers.set("terminal.checkpoints", params => (params.all ? [] : Promise.withResolvers().promise));
		await terminalRequest(nextOwner(), "/project", list, {}, undefined, "/s/a.jsonl");
		await saveTerminalsForQuit();
		expect(asked("terminal.checkpoints").at(-1)).toEqual({ userData: "/user", all: true });
		helper.length = 0;
		disposeTerminals(nextOwner());
		await settle();
		expect(helper).toEqual([]);
	});

	it("disposes a closed tab's terminals, whose files the worker's reader removes", async () => {
		const tab = nextOwner();
		disposeTerminals(tab);
		await settle();
		expect(helper).toEqual([{ method: "terminal.dispose", params: { owner: tab } }]);
	});

	it("leaves no terminal of a tab that closed while its create was on its way (P89)", async () => {
		const tab = nextOwner();
		const created = Promise.withResolvers<TerminalSnapshot[]>();
		answers.set("terminal.request", () => created.promise);
		const reply = terminalRequest(tab, "/project", { action: "create", cols: 80, rows: 24 }, {}, undefined, null);
		await settle();
		disposeTerminals(tab);
		created.resolve([{ id: "late", output: "", offset: 0, exited: false }]);
		expect(await reply).toEqual([]);
		expect(asked("terminal.dispose")).toHaveLength(2);
		// A request after the close is the tab's again (a reopened owner), not refused by the time it started.
		answers.set("terminal.request", () => [{ id: "next", output: "", offset: 0, exited: false }]);
		expect(await terminalRequest(tab, "/project", list, {}, undefined, null)).toHaveLength(1);
	});
});
