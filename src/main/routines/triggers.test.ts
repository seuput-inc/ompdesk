import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreRunner } from "../local/git/exec";
import { draft, fixture, gate, idle, testGit, until } from "./test-context";
import { firedDetail } from "./test-fired";

// Source captions as observed before deleting the TypeScript drivers.
const capture = JSON.parse(
	readFileSync(join(__dirname, "../../../native/ompdesk/crates/core/src/routines/runtime/captured.json"), "utf8"),
) as { fires: [string, string][] };
const sessionLines = capture.fires.filter(([id]) => id === "r4").map(([, line]) => line);

describe("sources owned by the running schedule engine", () => {
	it("keeps a source through a rename, replaces it through an edit and removes it on disable, delete and quit", async () => {
		const f = await fixture();
		const id = await f.add({ source: "session", events: ["done"] });
		const [first] = f.observers;
		expect(f.observers.size).toBe(1);
		await f.service.command({
			action: "save",
			id,
			draft: draft(f.work, { source: "session", events: ["done"] }, { name: "Renamed" }),
		});
		expect([...f.observers]).toEqual([first]);
		await f.service.command({ action: "save", id, draft: draft(f.work, { source: "session", events: ["waiting"] }) });
		expect(f.observers.size).toBe(1);
		expect([...f.observers][0]).not.toBe(first);
		await f.service.command({ action: "setEnabled", id, enabled: false });
		expect(f.observers.size).toBe(0);
		await f.service.command({ action: "setEnabled", id, enabled: true });
		expect(f.observers.size).toBe(1);
		await f.service.command({ action: "delete", id });
		expect(f.observers.size).toBe(0);
		await f.add({ source: "session", events: ["done"] });
		await f.close();
		expect(f.observers.size).toBe(0);
	});

	it("starts all five live sources only after the first window; a timed, webhook or off schedule never starts one", async () => {
		const ready = Promise.withResolvers<void>();
		const git = gate<CoreRunner>(),
			gh = gate<{ home: string; runner: CoreRunner | null }>();
		const accounts: string[] = [];
		const f = await fixture({
			ready: ready.promise,
			ports: {
				git: git.ask,
				github: gh.ask,
				email: name => {
					accounts.push(name);
					return null;
				},
			},
		});
		await f.add({ source: "github", repo: "o/r", events: ["pull_request"] });
		await f.add({ source: "git", repo: f.work, branch: "main" });
		await f.add({ source: "email", account: "Work" });
		await f.add({ source: "session", events: ["done"] });
		const file = await f.add({ source: "files", path: f.work });
		await f.add({ source: "files", path: join(f.work, "disabled") }, { enabled: false });
		await f.add({ source: "webhook", key: "" });
		await f.add({ source: "files", path: join(f.work, "timed") }, { frequency: { kind: "interval", minutes: 30 } });
		expect([f.observers.size, accounts.length, Object.keys(f.marks()).length]).toEqual([0, 0, 0]);
		ready.resolve();
		await Promise.all([git.waiting(), gh.waiting()]);
		await until(() => expect(f.marks()[file]?.mark).toEqual({ listing: { entries: {}, complete: true } }));
		expect(f.observers.size).toBe(1);
		await until(() => expect(f.log).toEqual([expect.stringContaining("no mail account has that name")]));
		expect(accounts).toContain("Work");
		await f.service.command({ action: "setPaused", paused: true });
		expect(f.observers.size).toBe(0);
		await until(() => expect(f.marks()).toEqual({}));
		await f.service.command({ action: "setPaused", paused: false });
		expect(f.observers.size).toBe(1);
		await f.close(); // closes even though both machine lookups are outstanding
	});

	it("retires a delayed lookup across disable/re-enable, even for the same trigger key", async () => {
		let calls = 0;
		const old = gate<CoreRunner>(),
			next = gate<CoreRunner>();
		const f = await fixture({ ports: { git: () => (++calls === 1 ? old.ask() : next.ask()) } });
		const id = await f.add({ source: "git", repo: f.work, branch: "main" });
		await old.waiting();
		await f.service.command({ action: "setEnabled", id, enabled: false });
		await f.service.command({ action: "setEnabled", id, enabled: true });
		await next.waiting();
		const runner = await testGit(f.dir);
		await old.allow({ ...runner, bin: join(f.dir, "retired-missing-tool") });
		await next.allow(runner);
		await next.waiting();
		expect(f.log).toHaveLength(1);
		expect(f.log[0]).toContain("not a git repository");
		expect(f.log[0]).not.toContain("retired-missing-tool");
		expect(f.marks()).toEqual({});
		expect(f.launched).toEqual([]);
	});

	it("drops marks while paused, off or edited instead of replaying changes made in those windows", async () => {
		const f = await fixture();
		const a = join(f.work, "a"),
			b = join(f.work, "b");
		mkdirSync(a);
		mkdirSync(b);
		const id = await f.add({ source: "files", path: a });
		await until(() => expect(f.marks()[id]).toBeDefined());
		await f.service.command({ action: "setPaused", paused: true });
		await until(() => expect(f.marks()).toEqual({}));
		writeFileSync(join(a, "while-paused"), "p");
		await f.service.command({ action: "setPaused", paused: false });
		await until(() =>
			expect(f.marks()[id]?.mark).toMatchObject({ listing: { entries: { "while-paused": expect.any(String) } } }),
		);
		await f.service.command({ action: "setEnabled", id, enabled: false });
		writeFileSync(join(a, "while-off"), "o");
		await f.service.command({ action: "setEnabled", id, enabled: true });
		await until(() =>
			expect(f.marks()[id]?.mark).toMatchObject({ listing: { entries: { "while-off": expect.any(String) } } }),
		);
		await f.service.command({ action: "save", id, draft: draft(f.work, { source: "files", path: b }) });
		await until(() => expect(f.marks()[id]?.mark).toEqual({ listing: { entries: {}, complete: true } }));
		writeFileSync(join(a, "old-watch"), "old");
		writeFileSync(join(b, "new-watch"), "new");
		await until(() => expect(f.fired).toEqual(["new-watch changed"]));
		await f.service.command({ action: "delete", id });
		await f.close();
		expect(f.marks()).toEqual({});
	});

	it("routes source events through the existing device quota and the pending-event run prompt", async () => {
		let budget = 1;
		const charged: string[] = [];
		const f = await fixture({
			hold: true,
			reserve: device => {
				charged.push(device);
				if (!budget) return { ok: false, reason: "Daily limit reached" };
				budget--;
				return {
					ok: true,
					refund: () => {
						budget++;
					},
				};
			},
		});
		f.tabs.push({ tabId: "t", sessionFile: "/s/t", cwd: "/fixture", title: "Title" });
		const id = await f.add({ source: "session", events: ["done", "waiting", "failed"] }, {}, "device-a");
		await f.emit(idle("t"));
		await until(() => expect(f.launched).toHaveLength(1));
		expect(f.launched[0]!.prompt.startsWith("Do the thing\n\nWhat fired this run:\n")).toBe(true);
		expect(firedDetail(f.launched[0]!.prompt)).toBe(sessionLines[0]);
		await f.emit({ type: "ask", tabId: "t", requestId: "q", text: "Question?" });
		await f.emit(idle("t", "error", "Nope"));
		f.launched[0]!.finish();
		await until(() =>
			expect(f.service.latest.runs[0]).toMatchObject({
				scheduleId: id,
				trigger: "event",
				status: "skipped",
				error: "Daily limit reached",
				detail: sessionLines.slice(1).join("\n"),
			}),
		);
		expect(charged).toEqual(["device-a", "device-a"]);
		expect(f.launched).toHaveLength(1);
	});

	it("records a broken source as a failed run once without stopping its healthy sibling", async () => {
		const f = await fixture();
		const missing = await f.add({ source: "files", path: join(f.work, "not-there") });
		f.tabs.push({ tabId: "t", sessionFile: "/t", cwd: "/fixture", title: "Title" });
		await f.add({ source: "session", events: ["done"] });
		await f.emit(idle("t"));
		await until(() =>
			expect(f.service.latest.runs.filter(run => run.scheduleId === missing)).toMatchObject([
				{ trigger: "event", status: "failed", error: expect.stringContaining("ENOENT") },
			]),
		);
		expect(f.log).toEqual([expect.stringContaining("ENOENT")]);
		expect(f.fired).toEqual(['Session "Title" in /fixture finished its turn']);
	});
});
