import { describe, expect, it } from "vitest";
import { LINK_LOG_MAX, LinkLog } from "./link-log";

describe("LinkLog", () => {
	it("keeps the newest 20 events, oldest first", () => {
		const log = new LinkLog();
		for (let at = 1; at <= 25; at++) log.note("resynced", "missed-events", at);
		const entries = log.entries();
		expect(entries).toHaveLength(LINK_LOG_MAX);
		expect(entries.map(entry => entry.at)).toEqual(Array.from({ length: 20 }, (_, index) => index + 6));
		expect(entries[0]).toEqual({ kind: "resynced", at: 6, detail: "missed-events" });
	});

	it("notes a drop of a link that was up and its return, once each, and tells its listeners", () => {
		const log = new LinkLog();
		let heard = 0;
		const stop = log.subscribe(() => heard++);
		for (const state of ["connecting", "open", "reconnecting", "reconnecting", "open", "open"] as const)
			log.state(state);
		expect(log.entries().map(entry => entry.kind)).toEqual(["dropped", "reconnected"]);
		expect(heard).toBe(2);
		stop();
		log.note("reloaded", "update");
		expect(heard).toBe(2);
	});
});
