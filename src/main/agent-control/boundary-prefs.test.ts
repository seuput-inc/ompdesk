import { describe, expect, it } from "vitest";
import { AGENT_CROSS_PROJECT_PREF, AGENT_PROJECT_BOUNDARY_PREF } from "../../shared/agent-control";
import type { RuntimeLogReport } from "../runtime-log-core";
import {
	type BoundaryPrefsStorage,
	boundaryLogLine,
	projectInList,
	refusePersonOnlyPref,
	setCrossProject,
	setProjectBoundary,
} from "./boundary-prefs";

function rig(initial: Record<string, unknown> = {}) {
	const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
	const writes: [string, unknown][] = [];
	const logged: RuntimeLogReport[] = [];
	const storage: BoundaryPrefsStorage = {
		get: key => data.get(key),
		set: (key, value) => {
			writes.push([key, value]);
			data.set(key, structuredClone(value));
		},
	};
	const log = (report: RuntimeLogReport) => logged.push(report);
	return {
		writes,
		logged,
		stored: (key: string) => data.get(key),
		grant: (payload: unknown, fromDesktopWindow = true) => setCrossProject(storage, payload, fromDesktopWindow, log),
		mode: (payload: unknown, fromDesktopWindow = true) =>
			setProjectBoundary(storage, payload, fromDesktopWindow, log),
	};
}

describe("the generic prefs write", () => {
	it("refuses the project boundary and the cross-project grant, and no other key", () => {
		for (const key of [AGENT_PROJECT_BOUNDARY_PREF, AGENT_CROSS_PROJECT_PREF])
			expect(() => refusePersonOnlyPref(key), key).toThrow(/\[invalid_preference_key\].*desktop window/);
		for (const key of ["agentControl", "agentControlFull", "sidebar", "theme"])
			expect(() => refusePersonOnlyPref(key), key).not.toThrow();
	});
});

describe("setCrossProject", () => {
	it("grants and takes back one session file, and logs each change with the file and on or off", () => {
		const r = rig({ [AGENT_CROSS_PROJECT_PREF]: { sessions: ["/s/kept.jsonl"] } });
		expect(r.grant({ sessionPath: "/s/hub.jsonl", on: true })).toBe(true);
		expect(r.stored(AGENT_CROSS_PROJECT_PREF)).toEqual({ sessions: ["/s/kept.jsonl", "/s/hub.jsonl"] });
		expect(r.grant({ sessionPath: "/s/hub.jsonl", on: false })).toBe(true);
		expect(r.stored(AGENT_CROSS_PROJECT_PREF)).toEqual({ sessions: ["/s/kept.jsonl"] });
		expect(r.logged).toEqual([
			{
				source: "agent-control",
				message: "cross-project grant",
				details: { level: "info", session: "/s/hub.jsonl", on: true },
			},
			{
				source: "agent-control",
				message: "cross-project grant",
				details: { level: "info", session: "/s/hub.jsonl", on: false },
			},
		]);
	});

	it("writes and logs nothing for a change that changes nothing", () => {
		const r = rig({ [AGENT_CROSS_PROJECT_PREF]: { sessions: ["/s/hub.jsonl"] } });
		expect(r.grant({ sessionPath: "/s/hub.jsonl", on: true })).toBe(false);
		expect(r.grant({ sessionPath: "/s/other.jsonl", on: false })).toBe(false);
		expect(r.writes).toEqual([]);
		expect(r.logged).toEqual([]);
	});

	it("is a desktop window's alone: a paired page's or an agent's call changes nothing", () => {
		const r = rig();
		expect(() => r.grant({ sessionPath: "/s/hub.jsonl", on: true }, false)).toThrow(/\[invalid_preference_key\]/);
		expect(r.writes).toEqual([]);
		expect(r.logged).toEqual([]);
	});

	it("refuses a payload that is no grant", () => {
		const r = rig();
		for (const payload of [
			undefined,
			"x",
			{},
			{ sessionPath: "", on: true },
			{ sessionPath: "/s/a.jsonl", on: "yes" },
		])
			expect(() => r.grant(payload), JSON.stringify(payload)).toThrow(/\[invalid_preference_key\]/);
		expect(r.writes).toEqual([]);
	});
});

describe("setProjectBoundary", () => {
	it("stores the chosen mode, keeps a stored earlier-opened option and logs the change", () => {
		const r = rig({ [AGENT_PROJECT_BOUNDARY_PREF]: { mode: "off", earlierOpened: "grant" } });
		expect(r.mode({ mode: "enforce" })).toBe(true);
		expect(r.stored(AGENT_PROJECT_BOUNDARY_PREF)).toEqual({ mode: "enforce", earlierOpened: "grant" });
		expect(r.logged).toEqual([
			{ source: "agent-control", message: "project boundary mode", details: { level: "info", mode: "enforce" } },
		]);
	});

	it("writes nothing when the mode is the one in effect, a default included", () => {
		const r = rig();
		expect(r.mode({ mode: "off" })).toBe(false);
		expect(r.writes).toEqual([]);
	});

	it("is a desktop window's alone and takes only a known mode", () => {
		const r = rig();
		expect(() => r.mode({ mode: "enforce" }, false)).toThrow(/\[invalid_preference_key\]/);
		for (const payload of [undefined, {}, { mode: "strict" }, { mode: true }])
			expect(() => r.mode(payload), JSON.stringify(payload)).toThrow(/\[invalid_preference_key\]/);
		expect(r.writes).toEqual([]);
	});
});

describe("boundaryLogLine", () => {
	it("is the runtime log's line of a call enforce would refuse: tool, caller, target and both projects", () => {
		expect(
			boundaryLogLine({
				tool: "ompdesk_session_read",
				caller: "/s/a.jsonl",
				target: "/s/b.jsonl",
				callerProject: "/pa",
				targetProject: null,
				extra: { nested: true },
			}),
		).toEqual({
			source: "agent-control",
			message: "project boundary would refuse",
			details: {
				level: "info",
				tool: "ompdesk_session_read",
				caller: "/s/a.jsonl",
				target: "/s/b.jsonl",
				callerProject: "/pa",
				targetProject: null,
			},
		});
	});
});

describe("projectInList", () => {
	const list = {
		projects: [{ path: "/repo/app", addedAt: 1 }],
		removed: ["/repo/old"],
		worktrees: { "/wt/gui-fix-1234567": "/repo/app" },
	};

	it("names a linked worktree's project and a listed or removed project itself", () => {
		expect(projectInList(list, "/wt/gui-fix-1234567")).toBe("/repo/app");
		expect(projectInList(list, "/repo/app")).toBe("/repo/app");
		expect(projectInList(list, "/repo/old")).toBe("/repo/old");
	});

	it("does not guess a folder the list does not know", () => {
		expect(projectInList(list, "/repo/app/sub")).toBeNull();
		expect(projectInList(list, "/elsewhere")).toBeNull();
	});
});
