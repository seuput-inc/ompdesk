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
	type SessionProcessesDeps,
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

function registry(frozen = false, deps: Partial<SessionProcessesDeps> = {}): SessionProcesses {
	return new SessionProcesses(file, {
		frozen: () => frozen,
		log: (message, details) => logs.push({ message, details }),
		...deps,
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
		"whose output path is closed stay at the launch that keeps their session when the automatic end is off, and the launch reports them",
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

			const after = registry(false, { endSpinning: () => false });
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
		"by default end at the launch only those that keep spinning on an output path whose other end closed",
		{ timeout: SLOW },
		async () => {
			const folder = fs.realpathSync(dir);
			const session = path.join(folder, "kept.jsonl");
			const before = registry(true);
			const tab = before.open({ cwd: folder, sessionPath: session });
			const chatty = await deafened(tab.tag, CHATTY, folder);
			const quiet = await deafened(tab.tag, QUIET_SERVER, folder);
			await tab.close();

			// The samples a minute apart run back to back here: the CPU each measures is real.
			const after = registry(false, { later: run => void setImmediate(run) });
			await after.sweep({ keep: new Set([session]), hostedHeld: () => false, hostedGraceMs: 0 });
			await after.settled();

			await vi.waitFor(() => expect(ended(chatty.child)).toBe(true));
			expect(ended(quiet.child)).toBe(false);
			const end = logs.find(entry => entry.message === "ended");
			expect(end?.details).toMatchObject({
				reason: "kept spinning on a closed output path whose other end is closed",
				processes: 1,
			});
			const found = JSON.parse(String(end?.details.found)) as Array<Record<string, unknown>>;
			expect(found).toEqual([
				expect.objectContaining({ pid: chatty.child.pid, outputClosed: "closed", sustained: expect.anything() }),
			]);
			const left = await after.open({ cwd: folder, sessionPath: session }).leftover();
			expect(left?.ended.map(item => item.pid)).toEqual([chatty.child.pid]);
			expect(left?.ended[0]?.sustained?.percents.every(percent => percent >= 50)).toBe(true);
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

	it("retries a surviving worker on a timer only once and records its tag for the next launch", async () => {
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
		// A broker may stay live; don't start another timer.
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

	it("releases scratch on disk care after a closed tab's last worker exits, without touching a restored tab", async () => {
		const before = held().sessions;
		const restored = before.open({ cwd: "/w", sessionPath: "/s/restored.jsonl" });
		const pending = before.open({ cwd: "/w", sessionPath: "/s/closed.jsonl" });
		const { sessions, calls, timers } = held();
		await sessions.sweep({
			keep: new Set(["/s/restored.jsonl", "/s/closed.jsonl"]),
			hostedHeld: () => false,
			hostedGraceMs: 0,
		});
		sessions.sessionReleased("/s/closed.jsonl");
		expect(sessions.held()).toContain(pending.tag);
		const worker = { ...NOTHING, kept: [{ pid: 7, name: "bun" }] };
		calls[0]?.settle(worker);
		await sessions.settled();
		timers[0]?.run();
		calls[1]?.settle(worker);
		await sessions.settled();
		const cleanup = sessions.retryReleased();
		expect(calls.map(call => call.tags)).toEqual([[pending.tag], [pending.tag], [pending.tag]]);
		calls[2]?.settle();
		await cleanup;
		expect(sessions.held()).toEqual(new Set([restored.tag]));
		expect(sessions.open({ cwd: "/w", sessionPath: "/s/restored.jsonl" }).tag).toBe(restored.tag);
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
				endSpinning: () => true,
				// Every later sample answers the same rows at once.
				later: run => void setImmediate(run),
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

	// The owner's answer of 20 Nov 2026: OMPdesk ends by itself a process whose output's other end is confirmed closed
	// and that keeps using CPU; a compiling dev server, busy for a while, must never be taken for one.
	it("by default ends a process whose output's peer is closed once it spins in every sample over a minute", async () => {
		const row = (pid: number, cpuPercent: number, startedMs = 1): TaggedProcess => ({
			pid,
			ppid: 1,
			bytes: 0,
			startedMs,
			name: "next-server",
			tag: "1".padStart(32, "0"),
			outputClosed: "closed",
			cpuPercent,
		});
		held().sessions.open({ cwd: "/w", sessionPath: "/s/a.jsonl" });
		// 20 spins throughout; 21 stops (a compile that finished); 22's pid names a later process by the last sample.
		const samples = [
			[row(20, 99), row(21, 100), row(22, 98)],
			[row(20, 100), row(21, 100), row(22, 99)],
			[row(20, 99), row(21, 3), row(22, 99, 2)],
		];
		const waits: Array<() => void> = [];
		const pids: number[] = [];
		const sessions = new SessionProcesses(file, {
			frozen: () => false,
			log: (message, details) => logs.push({ message, details }),
			later: run => waits.push(run),
			survey: async () => samples.shift() ?? [],
			endOnly: async (_tags, only) => {
				pids.push(...only.map(process => process.pid));
				return {
					ended: only.map(({ pid }) => ({ pid, name: "next-server", bytes: 0, forced: false })),
					left: [],
					kept: [],
					own: [],
				};
			},
		});
		const swept = sessions.sweep({ keep: new Set(["/s/a.jsonl"]), hostedHeld: () => false, hostedGraceMs: 0 });
		for (let turn = 0; turn < 20 && samples.length > 0; turn++) {
			await new Promise(resolve => setImmediate(resolve));
			for (const run of waits.splice(0)) run();
		}
		await swept;
		await sessions.settled();
		expect(pids).toEqual([20]);
		const end = logs.find(entry => entry.message === "ended");
		expect(String(end?.details.found)).toContain('"pid":20');
	});
});

describe("what each live session holds (All sessions › Resources)", () => {
	it("groups the listing by session, its omp first, and stops only another process of a live session", async () => {
		const endOnly = vi.fn(async (_tags: readonly string[], only: ReadonlyArray<{ pid: number }>) => ({
			ended: only.map(({ pid }) => ({ pid, name: "next-server", bytes: 0, forced: false })),
			left: [],
			kept: [],
			own: [],
		}));
		const sessions = registry(false, { endOnly });
		const big = sessions.open({ cwd: "/work/big", sessionPath: "/s/big.jsonl" });
		big.setPid(100);
		const small = sessions.open({ cwd: "/work/small" });
		small.setPid(200);
		const use = await sessions.use(async () => [
			{ pid: 100, ppid: 1, bytes: 300, name: "bun", tag: big.tag },
			{ pid: 101, ppid: 100, bytes: 900, name: "next-server", tag: big.tag, startedMs: 5 },
			{ pid: 200, ppid: 1, bytes: 250, name: "bun", tag: small.tag },
			{ pid: 300, ppid: 1, bytes: 9_000, name: "elsewhere" },
		]);
		expect(use?.map(session => [session.sessionPath, session.ompPid, session.bytes])).toEqual([
			["/s/big.jsonl", 100, 1_200],
			[undefined, 200, 250],
		]);
		expect(use?.[0]?.processes.map(process => [process.pid, process.omp])).toEqual([
			[100, true],
			[101, false],
		]);
		expect(await sessions.endProcess(100, 100, 1)).toBe(false);
		expect(await sessions.endProcess(999, 101, 5)).toBe(false);
		expect(endOnly).not.toHaveBeenCalled();
		expect(await sessions.endProcess(100, 101, 5)).toBe(true);
		expect(endOnly).toHaveBeenCalledWith([big.tag], [{ pid: 101, startedMs: 5 }]);
	});

	it("maps native Rust procs.sessionFootprints reports directly without full-OS process transfer", async () => {
		const sessions = registry(false);
		const big = sessions.open({ cwd: "/work/big", sessionPath: "/s/big.jsonl", device: "mac-mini" });
		big.setPid(100);
		const small = sessions.open({ cwd: "/work/small" });
		small.setPid(200);
		const footprints = vi.fn(async () => ({
			sampledAtMs: 1_000,
			totalSessionBytes: 1_450,
			totalOrphanBytes: 0,
			sessionCount: 2,
			orphanProcessCount: 0,
			sessions: [
				{
					tag: big.tag,
					cwd: "/work/big",
					sessionPath: "/s/big.jsonl",
					ompPid: 100,
					totalBytes: 1_200,
					ompBytes: 300,
					childrenBytes: 900,
					stockWorkerBytes: 0,
					totalCpuMs: 42,
					processCount: 2,
					childCount: 1,
					stockWorkerCount: 0,
					hasBlockingChildren: true,
					overBudget: false,
					topProcesses: [
						{ pid: 100, ppid: 1, name: "bun", bytes: 300, omp: true },
						{ pid: 101, ppid: 100, name: "next-server", bytes: 900, startedMs: 5, omp: false },
					],
				},
				{
					tag: small.tag,
					cwd: "/work/small",
					ompPid: 200,
					totalBytes: 250,
					ompBytes: 250,
					childrenBytes: 0,
					stockWorkerBytes: 0,
					totalCpuMs: 10,
					processCount: 1,
					childCount: 0,
					stockWorkerCount: 0,
					hasBlockingChildren: false,
					overBudget: false,
					topProcesses: [{ pid: 200, ppid: 1, name: "bun", bytes: 250, omp: true }],
				},
			],
			orphans: [],
		}));

		const use = await sessions.use(undefined, footprints);
		expect(footprints).toHaveBeenCalledWith(
			[
				{ tag: big.tag, cwd: "/work/big", sessionPath: "/s/big.jsonl", ompPid: 100 },
				{ tag: small.tag, cwd: "/work/small", ompPid: 200 },
			],
			{ includeOrphans: false, topPerSession: 32 },
		);
		expect(use).toEqual([
			{
				ompPid: 100,
				cwd: "/work/big",
				sessionPath: "/s/big.jsonl",
				device: "mac-mini",
				bytes: 1_200,
				processes: [
					{ pid: 100, name: "bun", bytes: 300, omp: true },
					{ pid: 101, name: "next-server", bytes: 900, startedMs: 5, omp: false },
				],
			},
			{
				ompPid: 200,
				cwd: "/work/small",
				bytes: 250,
				processes: [{ pid: 200, name: "bun", bytes: 250, omp: true }],
			},
		]);
	});
});
