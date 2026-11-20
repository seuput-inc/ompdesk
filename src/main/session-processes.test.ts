import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restartFollowUp } from "../../resources/gui-bridge/restart-core";
import { SESSION_TAG_ENV } from "./omp-launch";
import {
	type EndResult,
	listTaggedProcesses,
	RETRY_REMAINING_MS,
	SESSION_PROCESSES_FILE,
	SessionProcesses,
	type SessionProcessLogDetails,
	STOCK_WORKER_ARG,
	type TaggedProcess,
} from "./session-processes";

// Real processes through the real core (native/ompdesk/crates/core/src/procs): what a session's omp started is found by
// the tag in its environment, also once its parent is gone, and ended when its tab closes or did not come back.

/** A process that does nothing and ends by itself after two minutes, so a failed case leaves nothing behind for long. */
const HOLD = "setTimeout(() => {}, 120000)";
/** Starts a detached `HOLD`, prints its pid and exits: the grandchild is re-parented, as after `nohup server &`. */
const LEAVE_ORPHAN = `
const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(HOLD)}], {
	detached: true, stdio: "ignore", windowsHide: true,
});
child.unref();
process.stdout.write(String(child.pid));
`;

/**
 * A chatty server whose output has nowhere to go, as Next's dev server runs: an uncaught error is logged, so once the
 * reader of its output is gone every write fails and logging that failure fails again (the owner's report, 20 Nov
 * 2026: next-server at 100 % CPU after a relaunch).
 */
const CHATTY = `
process.on("uncaughtException", error => console.error("uncaught", error && error.code));
setInterval(() => console.log("tick"), 100);
setTimeout(() => process.exit(0), 120000);
process.stdout.write("up");
`;
/** A quiet server: listens, says on which port, then writes nothing. */
const QUIET_SERVER = `
const server = require("node:net").createServer().listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
setTimeout(() => process.exit(0), 120000);
`;
/** A process busy computing whose output goes to a file: its output has a reader, however much CPU it uses. */
const BUSY = `
process.stdout.write("up");
const end = Date.now() + 120000;
while (Date.now() < end) {}
`;

const SLOW = 60_000;
let dir: string;
let file: string;
const children: ChildProcess[] = [];
const orphans: number[] = [];
const logs: Array<{ message: string; details: SessionProcessLogDetails }> = [];

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** An environment as a tab's omp gets it: this one's, with the tab's tag (none: a process started outside OMPdesk). */
function env(tag: string | undefined): NodeJS.ProcessEnv {
	const own = { ...process.env };
	delete own[SESSION_TAG_ENV];
	return tag === undefined ? own : { ...own, [SESSION_TAG_ENV]: tag };
}

/** A running process with `tag`, resolved once node is up in it. */
async function running(tag: string | undefined, args: string[] = []): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", `process.stdout.write("up"); ${HOLD}`, ...args], {
		env: env(tag),
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
	children.push(child);
	await once(child.stdout as NonNullable<typeof child.stdout>, "data");
	return child;
}

/** The pid of a process with `tag` whose parent has exited. */
function orphan(tag: string | undefined): number {
	const pid = Number(execFileSync(process.execPath, ["-e", LEAVE_ORPHAN], { env: env(tag), windowsHide: true }));
	orphans.push(pid);
	return pid;
}

/** Whether a direct child has ended (its exit event, never the pid: a reaped pid may name another process). */
const ended = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

function registry(frozen = false, endSpinning?: boolean): SessionProcesses {
	return new SessionProcesses(file, {
		frozen: () => frozen,
		log: (message, details) => logs.push({ message, details }),
		...(endSpinning !== undefined ? { endSpinning } : {}),
	});
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gui-session-processes-"));
	file = path.join(dir, SESSION_PROCESSES_FILE);
	logs.length = 0;
});

afterEach(async () => {
	const killed = children.splice(0);
	for (const child of killed) child.kill("SIGKILL");
	for (const pid of orphans.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	// Windows refuses to remove a folder a running process has as its working folder.
	await Promise.all(killed.map(child => (ended(child) ? undefined : once(child, "exit"))));
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a session's processes, on this computer", () => {
	it("are read back by their tag, also once their parent is gone", { timeout: SLOW }, async () => {
		const tab = registry().open({ cwd: dir });
		const child = await running(tab.tag);
		const left = orphan(tab.tag);
		const outside = await running(undefined);
		const rows = (await listTaggedProcesses()) ?? [];
		const row = (pid: number | undefined) => rows.find(entry => entry.pid === pid);
		expect(row(child.pid)).toMatchObject({ tag: tab.tag, ppid: process.pid });
		expect(row(left)?.tag).toBe(tab.tag);
		expect(row(outside.pid)).toBeDefined();
		expect(row(outside.pid)?.tag).toBeUndefined();
		expect(row(left)?.bytes).toBeGreaterThan(1024 ** 2);
		expect(Date.now() - (row(left)?.startedMs ?? 0)).toBeLessThan(SLOW);
	});

	it("end when their tab closes, and nobody else's do", { timeout: SLOW }, async () => {
		const sessions = registry();
		const closing = sessions.open({ cwd: dir, sessionPath: path.join(dir, "closing.jsonl") });
		const open = sessions.open({ cwd: dir, sessionPath: path.join(dir, "open.jsonl") });
		expect(closing.tag).not.toBe(open.tag);
		const child = await running(closing.tag);
		const left = orphan(closing.tag);
		const others = await running(open.tag);
		const othersLeft = orphan(open.tag);
		const outside = await running(undefined);
		const outsideLeft = orphan(undefined);

		await closing.close();

		await vi.waitFor(() => expect(ended(child)).toBe(true));
		await vi.waitFor(() => expect(alive(left)).toBe(false));
		expect([ended(others), alive(othersLeft), ended(outside), alive(outsideLeft)]).toEqual([
			false,
			true,
			false,
			true,
		]);
		// Windows starts a console host under a console program; it inherits the tag and ends with the rest.
		expect(logs).toEqual([
			{
				message: "ended",
				details: expect.objectContaining({ reason: "closed", folder: dir, session: "closing.jsonl" }),
			},
		]);
		expect(Number(logs[0]?.details.processes)).toBeGreaterThanOrEqual(2);
		// The closed tab's tag is forgotten; the open tab's is still in the file.
		expect(sessions.owners().map(owner => owner.tag)).toEqual([open.tag]);
	});

	it("are left to stock when they are stock omp's own shared workers", { timeout: SLOW }, async () => {
		const sessions = registry();
		const tab = sessions.open({ cwd: dir });
		// Stock's service broker runs as `<omp> __omp_worker_daemon_broker` with the first omp's environment.
		const broker = await running(tab.tag, [`${STOCK_WORKER_ARG}daemon_broker`]);
		const leftover = await running(tab.tag);

		await tab.close();

		await vi.waitFor(() => expect(ended(leftover)).toBe(true));
		expect(ended(broker)).toBe(false);
		expect(Number(logs[0]?.details.processes)).toBeGreaterThanOrEqual(1);
		expect(Number(logs[0]?.details.kept)).toBeGreaterThanOrEqual(1);
		// The tag stays in the file while something still carries it.
		expect(sessions.owners().map(owner => owner.tag)).toEqual([tab.tag]);
	});

	it("stay through a quit, and the tab that comes back on the session takes them over", {
		timeout: SLOW,
	}, async () => {
		const session = path.join(dir, "kept.jsonl");
		const before = registry(true);
		const tab = before.open({ cwd: dir, sessionPath: session });
		const left = orphan(tab.tag);
		// The quit disposes every tab.
		await tab.close();
		expect(alive(left)).toBe(true);

		const after = registry();
		await after.sweep({ keep: new Set([session]), hostedHeld: () => false, hostedGraceMs: 0 });
		expect(alive(left)).toBe(true);
		const back = after.open({ cwd: dir, sessionPath: session });
		expect(back.tag).toBe(tab.tag);
		await back.close();
		await vi.waitFor(() => expect(alive(left)).toBe(false));
	});

	it("end at the next launch when their session did not come back", { timeout: SLOW }, async () => {
		const kept = path.join(dir, "kept.jsonl");
		const gone = path.join(dir, "gone.jsonl");
		// A crash or a forced quit: no tab was closed, the file still names both tags.
		const before = registry();
		const keptTab = before.open({ cwd: dir, sessionPath: kept });
		const goneTab = before.open({ cwd: dir, sessionPath: gone });
		const unsaved = before.open({ cwd: dir });
		const keptLeft = orphan(keptTab.tag);
		const goneLeft = orphan(goneTab.tag);
		const unsavedLeft = orphan(unsaved.tag);
		const outsideLeft = orphan(undefined);

		const after = registry();
		await after.sweep({ keep: new Set([kept]), hostedHeld: () => false, hostedGraceMs: 0 });

		await vi.waitFor(() => expect([alive(goneLeft), alive(unsavedLeft)]).toEqual([false, false]));
		expect([alive(keptLeft), alive(outsideLeft)]).toEqual([true, true]);
		expect(logs.map(entry => [entry.message, entry.details.reason, entry.details.session])).toEqual(
			expect.arrayContaining([
				["ended", "relaunch", "gone.jsonl"],
				["ended", "relaunch", undefined],
			]),
		);
		expect(after.owners().map(owner => owner.tag)).toEqual([keptTab.tag]);
	});

	/**
	 * Starts `script` with its output piped to this test, waits for its first output, then closes the test's end, as the
	 * quit took the omp (or a Playwright run between) that read it. `args` stand in for a command line's secrets.
	 */
	async function deafened(tag: string, script: string, cwd: string, args: string[] = []) {
		const child = spawn(process.execPath, ["-e", script, "--", ...args], {
			env: env(tag),
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		children.push(child);
		const out = child.stdout as NonNullable<typeof child.stdout>;
		const [first] = (await Promise.race([
			once(out, "data"),
			once(child, "exit").then(([code]) => {
				throw new Error(`exited (${code}) before its first output`);
			}),
		])) as [Buffer];
		out.destroy();
		child.stderr?.destroy();
		return { child, said: first.toString() };
	}

	// Linux (tests and CI only, no product) does not tell a closed pipe's writer from any other: not checked there.
	it.skipIf(process.platform === "linux")(
		"whose output path is closed stay at the launch that keeps their session, and the launch reports them",
		{ timeout: SLOW },
		async () => {
			const folder = fs.realpathSync(dir);
			const session = path.join(folder, "kept.jsonl");
			const before = registry(true);
			const tab = before.open({ cwd: folder, sessionPath: session });
			const secret = `--token=SYNTH-${Math.random().toString(36).slice(2)}`;
			const chatty = await deafened(tab.tag, CHATTY, path.dirname(folder), [secret]);
			const quiet = await deafened(tab.tag, QUIET_SERVER, folder);
			const logFile = path.join(folder, "busy.log");
			const sink = fs.openSync(logFile, "w");
			const busy = spawn(process.execPath, ["-e", BUSY], {
				env: env(tab.tag),
				cwd: folder,
				stdio: ["ignore", sink, sink],
				windowsHide: true,
			});
			children.push(busy);
			fs.closeSync(sink);
			await vi.waitFor(() => expect(fs.readFileSync(logFile, "utf8")).toContain("up"));
			await tab.close();

			const after = registry();
			await after.sweep({ keep: new Set([session]), hostedHeld: () => false, hostedGraceMs: 0 });
			await after.settled();

			expect([ended(chatty.child), ended(quiet.child), ended(busy)]).toEqual([false, false, false]);
			const reports = logs.filter(entry => entry.message === "output path closed");
			expect(reports).toHaveLength(1);
			const found = JSON.parse(String(reports[0]?.details.found)) as Array<Record<string, unknown>>;
			const by = (pid: number | undefined) => found.find(item => item.pid === pid);
			expect(found.map(item => item.pid).sort()).toEqual([chatty.child.pid, quiet.child.pid].sort());
			expect(by(chatty.child.pid)).toMatchObject({ outputClosed: "closed", spinning: true, outside: true });
			expect(by(quiet.child.pid)).toMatchObject({
				outputClosed: "closed",
				folder: ".",
				ports: [Number(quiet.said)],
			});
			expect(by(quiet.child.pid)?.spinning).toBeUndefined();
			expect(JSON.stringify(logs)).not.toContain("SYNTH-");

			// The tab back on the session takes the tag over; its continuation names what still runs.
			const back = after.open({ cwd: folder, sessionPath: session });
			const left = await back.leftover();
			const named = (pid: number | undefined) => left?.running.find(item => item.pid === pid);
			expect(named(chatty.child.pid)).toMatchObject({ outputClosed: "closed", spinning: true });
			expect(named(quiet.child.pid)).toMatchObject({ outputClosed: "closed", ports: [Number(quiet.said)] });
			expect(named(busy.pid)).toMatchObject({ folder: "." });
			expect(named(busy.pid)?.outputClosed).toBeUndefined();
			expect(left?.ended).toEqual([]);
			const notice = restartFollowUp([], [], "restored", [], left)?.content ?? "";
			expect(notice).toContain(`- ${chatty.child.pid} `);
			expect(notice).toContain("spinning: ");
			expect(notice).toContain(`listening on ${quiet.said}`);
			expect(notice).toContain("outside the session folder");
			expect(`${notice}${JSON.stringify(left)}`).not.toContain("SYNTH-");
		},
	);

	it.skipIf(process.platform === "linux")(
		"with the switch on, end at the launch only those spinning on an output path whose other end closed",
		{ timeout: SLOW },
		async () => {
			const folder = fs.realpathSync(dir);
			const session = path.join(folder, "kept.jsonl");
			const before = registry(true);
			const tab = before.open({ cwd: folder, sessionPath: session });
			const chatty = await deafened(tab.tag, CHATTY, folder);
			const quiet = await deafened(tab.tag, QUIET_SERVER, folder);
			await tab.close();

			const after = registry(false, true);
			await after.sweep({ keep: new Set([session]), hostedHeld: () => false, hostedGraceMs: 0 });
			await after.settled();

			await vi.waitFor(() => expect(ended(chatty.child)).toBe(true));
			expect(ended(quiet.child)).toBe(false);
			const end = logs.find(entry => entry.message === "ended");
			expect(end?.details).toMatchObject({
				reason: "spinning on a closed output path, its other end closed",
				processes: 1,
			});
			const left = await after.open({ cwd: folder, sessionPath: session }).leftover();
			expect(left?.ended.map(item => item.pid)).toEqual([chatty.child.pid]);
			expect(left?.running.map(item => item.pid)).toEqual([quiet.child.pid]);
			// The tag stays: its tab is open and a process of it still runs.
			expect(after.owners().map(owner => owner.tag)).toEqual([tab.tag]);
		},
	);
});

describe("which tags end, and when", () => {
	const NOTHING: EndResult = { ended: [], left: [], kept: [], own: [] };

	/** A registry whose ends are held until the test settles them. */
	function held(options: { frozen?: () => boolean } = {}) {
		const calls: Array<{ tags: readonly string[]; settle: (result?: EndResult | Error) => void }> = [];
		const timers: Array<{ run: () => void; ms: number }> = [];
		let made = 0;
		const sessions = new SessionProcesses(file, {
			frozen: options.frozen ?? (() => false),
			log: (message, details) => logs.push({ message, details }),
			newTag: () => (++made).toString(16).padStart(32, "0"),
			later: (run, ms) => timers.push({ run, ms }),
			// What a kept tag left is looked at, never ended here (the cases above run it on real processes).
			survey: async () => [],
			end: tags => {
				const { promise, resolve, reject } = Promise.withResolvers<EndResult>();
				calls.push({
					tags,
					settle: result => (result instanceof Error ? reject(result) : resolve(result ?? NOTHING)),
				});
				return promise;
			},
		});
		return { sessions, calls, timers };
	}

	it("gives a session reopened while its closed tab's processes go down a tag of its own", async () => {
		const { sessions, calls } = held();
		const first = sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
		const closed = first.close();
		// Reopened before the core answered: taking the old tag over would end the new tab's omp with the leftovers.
		const second = sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
		expect(second.tag).not.toBe(first.tag);
		expect(calls.map(call => call.tags)).toEqual([[first.tag]]);
		calls[0]?.settle();
		await closed;
		expect(sessions.owners().map(owner => owner.tag)).toEqual([second.tag]);
	});

	it("tries a tag once more when its end left something running, then leaves it to the next launch", async () => {
		const { sessions, calls, timers } = held();
		const tab = sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
		const closed = tab.close();
		// Stock's worker was still up (its omp had just exited), so what it started was kept with it.
		const remaining: EndResult = { ...NOTHING, kept: [{ pid: 7, name: "bun" }] };
		calls[0]?.settle(remaining);
		await closed;
		expect(sessions.owners().map(owner => owner.tag)).toEqual([tab.tag]);
		expect(timers.map(timer => timer.ms)).toEqual([RETRY_REMAINING_MS]);
		timers[0]?.run();
		expect(calls.map(call => call.tags)).toEqual([[tab.tag], [tab.tag]]);
		// Still there (a broker whose services the person keeps): no third try in this launch.
		calls[1]?.settle(remaining);
		await sessions.settled();
		expect(timers).toHaveLength(1);
		expect(sessions.owners().map(owner => owner.tag)).toEqual([tab.tag]);
		// The next launch tries again; with nothing left the tag is forgotten.
		const next = held();
		await Promise.all([
			next.sessions.sweep({ keep: new Set(), hostedHeld: () => false, hostedGraceMs: 0 }),
			Promise.resolve().then(() => next.calls[0]?.settle()),
		]);
		expect(next.sessions.owners()).toEqual([]);
	});

	it("keeps a tag whose end failed for the next launch", async () => {
		const { sessions, calls } = held();
		const tab = sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
		const closed = tab.close();
		calls[0]?.settle(new Error("ompdesk-core is not running"));
		await closed;
		expect(logs.map(entry => entry.message)).toEqual(["not ended"]);
		expect(
			held()
				.sessions.owners()
				.map(owner => owner.tag),
		).toEqual([tab.tag]);
	});

	it("ends nothing once a quit is underway", async () => {
		let quitting = false;
		const { sessions, calls } = held({ frozen: () => quitting });
		const tab = sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
		quitting = true;
		await tab.close();
		sessions.sessionReleased("/s/a.jsonl");
		expect(calls).toEqual([]);
		expect(sessions.owners().map(owner => owner.tag)).toEqual([tab.tag]);
	});

	it("ends what the last launch left for a restored tab that is closed before it ever started", async () => {
		held().sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
		const { sessions, calls } = held();
		await sessions.sweep({ keep: new Set(["/s/a.jsonl"]), hostedHeld: () => false, hostedGraceMs: 0 });
		expect(calls).toEqual([]);
		sessions.sessionReleased("/s/a.jsonl");
		expect(calls).toHaveLength(1);
		calls[0]?.settle();
		await sessions.settled();
		expect(sessions.owners()).toEqual([]);
	});

	it("gives a hosted session's device the host tab's grace to come back", async () => {
		const before = held().sessions;
		const back = before.open({ cwd: "/w", sessionPath: "/s/back.jsonl", device: "MacBook" });
		const away = before.open({ cwd: "/w", sessionPath: "/s/away.jsonl", device: "MacBook" });
		const { sessions, calls, timers } = held();
		const heldNow = new Set<string>();
		await sessions.sweep({ keep: new Set(), hostedHeld: path => heldNow.has(path), hostedGraceMs: 600_000 });
		// Nothing of a hosted session ends at launch: its device may be reconnecting.
		expect(calls).toEqual([]);
		expect(timers.map(timer => timer.ms)).toEqual([600_000]);
		// The device reopened one of its tabs, which has not started its omp yet.
		heldNow.add("/s/back.jsonl");
		timers[0]?.run();
		expect(calls.map(call => call.tags)).toEqual([[away.tag]]);
		calls[0]?.settle();
		await sessions.settled();
		expect(sessions.owners().map(owner => owner.tag)).toEqual([back.tag]);
	});

	it("drops a damaged file's records instead of ending by them", () => {
		fs.writeFileSync(file, JSON.stringify({ tags: [{ tag: "not-a-tag", cwd: "/w", since: 1 }, { cwd: "/w" }, 7] }));
		expect(held().sessions.owners()).toEqual([]);
	});

	// The hub's finding of 20 Nov 2026: a closed output path (macOS SS_CANTSENDMORE) is also what a process's own
	// shutdown(SHUT_WR) leaves, with its peer alive and reading. Only a peer seen closed may let the switch end it.
	it("with the switch on, ends a spinning process only once its output's peer is seen closed", async () => {
		const spinner = (pid: number, extra: Partial<TaggedProcess> = {}): TaggedProcess => ({
			pid,
			ppid: 1,
			bytes: 0,
			startedMs: 1,
			name: "node",
			tag: "1".padStart(32, "0"),
			outputClosed: "unknown",
			cpuPercent: 99,
			...extra,
		});
		const ended = async (rows: TaggedProcess[]) => {
			fs.rmSync(file, { force: true });
			held().sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
			const pids: number[] = [];
			const sessions = new SessionProcesses(file, {
				frozen: () => false,
				log: (message, details) => logs.push({ message, details }),
				endSpinning: true,
				survey: async () => rows,
				endOnly: async (_tags, only) => {
					pids.push(...only.map(process => process.pid));
					return { ended: [], left: [], kept: [], own: [] };
				},
			});
			await sessions.sweep({ keep: new Set(["/s/a.jsonl"]), hostedHeld: () => false, hostedGraceMs: 0 });
			await sessions.settled();
			return pids;
		};
		// Shut down for writing by itself (macOS: still connected), or a socket that does not say.
		expect(await ended([spinner(10, { outputClosed: "open" }), spinner(11)])).toEqual([]);
		expect(await ended([spinner(12, { outputClosed: "closed" }), spinner(13, { outputClosed: "open" })])).toEqual([
			12,
		]);
	});
});
