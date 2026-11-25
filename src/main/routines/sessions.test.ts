import { describe, expect, it } from "vitest";
import { fixture, idle, type TestTab } from "./test-context";

const tab = (tabId: string, extra: Partial<TestTab> = {}): TestTab => ({
	tabId,
	sessionFile: `/s/${tabId}.jsonl`,
	cwd: "/x/y",
	title: "Refactor",
	...extra,
});

describe("the native session source on stock pool notices", () => {
	it("fires once per completed turn; busy starts a new turn", async () => {
		const f = await fixture();
		f.tabs.push(tab("a"));
		await f.add({ source: "session", events: ["done"] });
		await f.emit(idle("a"));
		await f.emit(idle("a"));
		expect(f.fired).toEqual(['Session "Refactor" in /x/y finished its turn']);
		await f.emit({ type: "busy", tabId: "a" });
		await f.emit(idle("a"));
		expect(f.fired).toHaveLength(2);
	});

	it("separates failed turns and questions, and ignores stops, empty outcomes and missing sessions", async () => {
		const f = await fixture();
		f.tabs.push(tab("a"), tab("b", { sessionFile: undefined }));
		await f.add({ source: "session", events: ["failed"] });
		await f.add({ source: "session", events: ["waiting"] });
		await f.add({ source: "session", events: ["done"] }, { enabled: false });
		for (const activity of [idle("a", "aborted"), idle("a"), idle("b", "error"), idle("gone", "error")])
			await f.emit(activity);
		await f.emit({ type: "idle", tabId: "a", outcome: undefined });
		await f.emit(idle("a", "error", "Rate limited"));
		const ask = { type: "ask" as const, tabId: "a", requestId: "r1", text: "Delete the file?" };
		await f.emit(ask);
		await f.emit(ask);
		expect(f.fired).toEqual([
			'Session "Refactor" in /x/y failed its turn: Rate limited',
			'Session "Refactor" in /x/y is waiting for an answer: Delete the file?',
		]);
	});

	it("does not wake its own family or a paired tab, including when the opener closed", async () => {
		const f = await fixture();
		const wake = "/s/wake.jsonl";
		f.tabs.push(
			tab("wake"),
			tab("kid", { openedBy: "wake" }),
			tab("grandkid", { openedBy: "kid" }),
			tab("relaunched", { openedBy: "stale-tab-id", openedBySession: wake }),
			tab("remote", { device: "dev-1" }),
			tab("own"),
		);
		await f.add({ source: "session", events: ["done"] }, { wakeSession: wake });
		for (const id of ["wake", "kid", "grandkid", "remote"]) await f.emit(idle(id));
		f.tabs.shift();
		await f.emit(idle("relaunched"));
		expect(f.fired).toEqual([]);
		await f.emit(idle("own"));
		expect(f.launched).toMatchObject([{ wake: true, schedule: { wakeSession: wake } }]);
	});

	it("follows the whole family when it wakes none and matches folders at path segments", async () => {
		const f = await fixture();
		f.tabs.push(
			tab("in", { cwd: "/work/app/api" }),
			tab("near", { cwd: "/work/application" }),
			tab("win", { cwd: "C:\\Work\\App", openedBy: "in" }),
		);
		const id = await f.add({ source: "session", events: ["done"], folder: "/work/app" });
		for (const tab of f.tabs) await f.emit(idle(tab.tabId));
		expect(f.fired).toEqual([
			'Session "Refactor" in /work/app/api finished its turn',
			'Session "Refactor" in C:\\Work\\App finished its turn',
		]);
		const retired = [...f.observers][0]!;
		await f.service.command({ action: "setEnabled", id, enabled: false });
		expect(f.observers.size).toBe(0);
		await f.service.command({ action: "setEnabled", id, enabled: true });
		retired(idle("in"));
		await f.service.command({ action: "get" });
		expect(f.fired).toHaveLength(2);
		await f.close();
		expect(f.observers.size).toBe(0);
	});
});
