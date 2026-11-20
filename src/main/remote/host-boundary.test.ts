import { describe, expect, it } from "vitest";
import type { ProjectBoundaryEarlier, ProjectBoundaryMode } from "../../shared/agent-control";
import type { SessionInfo } from "../../shared/ipc-types";
import type { SchedulesState } from "../../shared/schedules";
import {
	HOST_CLAIM_KEY,
	hostClaimOf,
	judgeHostClaim,
	OTHER_PROJECT,
	withCallerClaim,
	withHostClaim,
} from "../agent-control/boundary-claim";
import type { RuntimeLogReport } from "../runtime-log-core";
import { hostBoundary, scopedSchedules, scopedSessions } from "./host-boundary";

/** A host whose folders are their own projects, except a worktree of `/repo/app`. */
function host(mode: ProjectBoundaryMode, earlierOpened: ProjectBoundaryEarlier = "grant") {
	const logged: RuntimeLogReport[] = [];
	return {
		logged,
		deps: {
			settings: () => ({ mode, earlierOpened }),
			projectOf: async (folder: string) => (folder === "/wt/app-fix" ? "/repo/app" : folder),
			log: (report: RuntimeLogReport) => logged.push(report),
		},
	};
}

/** What the link's client sends for a call by a session in `cwd` on `device` (null: the sending computer itself). */
function sent(
	params: object,
	caller: { device: string | null; cwd: string; granted?: boolean; own?: string[]; earlier?: string[] },
) {
	const claim = {
		caller: "/s/caller.jsonl",
		device: caller.device,
		cwd: caller.cwd,
		granted: caller.granted ?? false,
		own: caller.own ?? [],
		earlier: caller.earlier ?? [],
	};
	return withCallerClaim(claim, () => withHostClaim("host-1", params));
}

describe("the caller a request carries", () => {
	it("is added only to what main sends while it answers a control-tool call", () => {
		expect(withHostClaim("host-1", { sessionPath: "/s/a.jsonl" })).toEqual({ sessionPath: "/s/a.jsonl" });
		expect(
			sent(
				{ sessionPath: "/s/a.jsonl" },
				{ device: "host-1", cwd: "/repo/app", own: ["/s/c.jsonl"], earlier: ["/s/o"] },
			),
		).toEqual({
			sessionPath: "/s/a.jsonl",
			[HOST_CLAIM_KEY]: {
				caller: "/s/caller.jsonl",
				cwd: "/repo/app",
				granted: false,
				own: ["/s/c.jsonl"],
				earlier: ["/s/o"],
			},
		});
	});

	it("names the caller's folder only to the host its tab runs on, and survives an await", async () => {
		// A caller on the sending computer, or on another host, has no folder of this host's.
		const elsewhere = { caller: "/s/caller.jsonl", granted: false, own: [], earlier: [] };
		expect(hostClaimOf(sent({}, { device: null, cwd: "/Users/me/app" }))).toEqual(elsewhere);
		expect(hostClaimOf(sent({}, { device: "host-2", cwd: "/repo/app" }))).toEqual(elsewhere);
		const here = { caller: "tab-1", device: "host-1", cwd: "/repo/app", granted: true, own: [], earlier: [] };
		const later = await withCallerClaim(here, async () => {
			await Promise.resolve();
			return withHostClaim("host-1", {});
		});
		expect(hostClaimOf(later)).toEqual({ caller: "tab-1", cwd: "/repo/app", granted: true, own: [], earlier: [] });
	});

	it("is nobody for a malformed claim, and leaves params that are no object alone", () => {
		expect(withCallerClaim({ device: 3 }, () => withHostClaim("host-1", { a: 1 }))).toEqual({ a: 1 });
		expect(sent([1, 2], { device: null, cwd: "/x" })).toEqual([1, 2]);
		expect(hostClaimOf({ [HOST_CLAIM_KEY]: { granted: "yes" } })).toBeNull();
		expect(hostClaimOf(null)).toBeNull();
	});
});

describe("judgeHostClaim", () => {
	const claim = {
		caller: "/s/caller.jsonl",
		granted: false,
		own: ["/s/child.jsonl", "/wt/child"],
		earlier: ["/s/old.jsonl", "/wt/old"],
	};
	const enforce = { mode: "enforce", earlierOpened: "grant" } as const;

	it("allows the same project, the caller's own sessions and folders, a grant, and everything while off", () => {
		expect(judgeHostClaim(enforce, claim, "/repo/app", { session: "/s/x.jsonl", project: "/repo/app" })).toBe(
			"allow",
		);
		expect(judgeHostClaim(enforce, claim, null, { session: "/s/child.jsonl", project: "/repo/b" })).toBe("allow");
		expect(judgeHostClaim(enforce, claim, null, { folder: "/wt/child", project: null })).toBe("allow");
		expect(judgeHostClaim(enforce, { ...claim, granted: true }, null, { project: "/repo/b" })).toBe("allow");
		// A hosted tab this caller opened, whatever folder it is in.
		expect(judgeHostClaim(enforce, claim, null, { folder: "/work", project: "/work", opened: true })).toBe("allow");
		const off = { mode: "off", earlierOpened: "grant" } as const;
		expect(judgeHostClaim(off, claim, null, { session: "/s/x.jsonl", project: "/repo/b" })).toBe("allow");
	});

	it("keeps what the caller opened before a check ran out of reach unless this computer says visible", () => {
		// The owner's answer (20 Nov 2026): another project's session opened before the boundary needs the grant.
		for (const old of [
			{ session: "/s/old.jsonl", project: "/repo/b" },
			{ folder: "/wt/old", project: null },
		]) {
			expect(judgeHostClaim(enforce, claim, null, old)).toBe("refuse");
			expect(judgeHostClaim({ mode: "log", earlierOpened: "grant" }, claim, null, old)).toBe("log");
			expect(judgeHostClaim({ mode: "enforce", earlierOpened: "visible" }, claim, null, old)).toBe("allow");
			expect(judgeHostClaim(enforce, { ...claim, granted: true }, null, old)).toBe("allow");
		}
		// An older device sends no `earlier`: its `own` (everything its caller opened) is read as before.
		const older = hostClaimOf({
			[HOST_CLAIM_KEY]: { caller: "/s/caller.jsonl", granted: false, own: ["/s/old.jsonl"] },
		});
		expect(older?.earlier).toEqual([]);
		if (older)
			expect(judgeHostClaim(enforce, older, null, { session: "/s/old.jsonl", project: "/repo/b" })).toBe("allow");
	});

	it("refuses another project and anything unknown under enforce, and only logs it under log", () => {
		const other = { session: "/s/x.jsonl", folder: "/repo/b", project: "/repo/b" };
		expect(judgeHostClaim(enforce, claim, "/repo/app", other)).toBe("refuse");
		expect(judgeHostClaim({ mode: "log", earlierOpened: "grant" }, claim, "/repo/app", other)).toBe("log");
		// Two unknown projects are never the same one; a session is not the caller's because its folder is.
		expect(judgeHostClaim(enforce, claim, null, { session: "/s/x.jsonl", project: null })).toBe("refuse");
		expect(judgeHostClaim(enforce, claim, null, { session: "/s/x.jsonl", folder: "/wt/child", project: null })).toBe(
			"refuse",
		);
	});
});

describe("hostBoundary", () => {
	const onHost = { device: "host-1", cwd: "/wt/app-fix" };

	it("judges nothing for a request that names no caller, a granted caller, or while the mode is off", async () => {
		const target = { session: "/s/x.jsonl", folder: "/repo/b" };
		expect(await hostBoundary(host("enforce").deps, "dev-1", "sessions.messages", {}, target)).toBeNull();
		const granted = sent({}, { ...onHost, granted: true });
		expect(await hostBoundary(host("enforce").deps, "dev-1", "sessions.messages", granted, target)).toBeNull();
		expect(await hostBoundary(host("off").deps, "dev-1", "sessions.messages", sent({}, onHost), target)).toBeNull();
	});

	it("lets a caller that runs here reach its own project, a worktree of it included", async () => {
		const inScope = await hostBoundary(host("enforce").deps, "dev-1", "sessions.messages", sent({}, onHost), {
			session: "/s/x.jsonl",
			folder: "/repo/app",
		});
		expect(await inScope?.({ folder: "/repo/app" })).toBe(true);
		expect(await inScope?.({ folder: "/repo/b" })).toBe(false);
	});

	it("refuses another project's session and folder with the tools' own words, before anything is served", async () => {
		const { deps, logged } = host("enforce");
		for (const target of [{ session: "/s/x.jsonl", folder: "/repo/b" }, { folder: "/repo/b" }, { folder: null }])
			await expect(hostBoundary(deps, "dev-1", "tab.open", sent({}, onHost), target)).rejects.toThrow(
				`[other_project] ${OTHER_PROJECT}`,
			);
		// A caller on the device itself has no project here: only what it opened, or a grant, reaches this computer.
		const fromDevice = sent({}, { device: null, cwd: "/repo/b", own: ["/s/child.jsonl"] });
		await expect(hostBoundary(deps, "dev-1", "tab.command", fromDevice, { folder: "/repo/b" })).rejects.toThrow(
			/other_project/,
		);
		expect(
			await hostBoundary(deps, "dev-1", "tab.command", fromDevice, { session: "/s/child.jsonl", folder: "/repo/b" }),
		).not.toBeNull();
		expect(logged).toEqual([]);
	});

	it("under log refuses nothing, writes the line and filters no list", async () => {
		const { deps, logged } = host("log");
		const inScope = await hostBoundary(deps, "dev-1", "sessions.messages", sent({}, onHost), {
			session: "/s/x.jsonl",
			folder: "/repo/b",
		});
		expect(inScope).toBeNull();
		expect(logged).toEqual([
			{
				source: "agent-control",
				message: "project boundary would refuse",
				details: {
					level: "info",
					tool: "sessions.messages",
					caller: "/wt/app-fix",
					target: "/s/x.jsonl",
					callerProject: "/repo/app",
					targetProject: "/repo/b",
				},
			},
		]);
	});
});

describe("a list for a caller the boundary keeps to its project", () => {
	const inScope = async (target: { folder?: string | null }) => target.folder === "/repo/app";

	it("keeps the caller's rows and blanks every other one: counted, with nothing of the session in it", async () => {
		const row = (id: string, cwd: string): SessionInfo => ({
			path: `/s/${id}.jsonl`,
			id,
			title: `Title ${id}`,
			cwd,
			created: "2026-11-01",
			modified: "2026-11-02",
			messageCount: 4,
			size: 100,
			status: "complete",
			firstMessage: `first ${id}`,
			heldOnHost: true,
		});
		const scoped = await scopedSessions([row("mine", "/repo/app"), row("theirs", "/repo/b")], inScope);
		expect(scoped[0]).toEqual(row("mine", "/repo/app"));
		expect(scoped[1]).toEqual({
			path: "outside:1",
			id: "outside:1",
			title: null,
			cwd: "",
			created: "",
			modified: "",
			messageCount: 0,
			size: 0,
			status: "unknown",
			firstMessage: "",
			outsideProject: true,
		});
		expect(JSON.stringify(scoped[1])).not.toMatch(/theirs|repo/);
	});

	it("leaves another project's schedules out with their runs and next starts, as a count", async () => {
		const schedule = (id: string, cwd: string) => ({
			id,
			createdAt: "",
			name: `[agent] ${id}`,
			prompt: "p",
			cwd,
			frequency: { kind: "interval" as const, minutes: 30 },
			enabled: true,
		});
		const run = (scheduleId: string) => ({ id: `r-${scheduleId}`, scheduleId });
		const state = {
			paused: false,
			schedules: [schedule("mine", "/repo/app"), schedule("theirs", "/repo/b")],
			runs: [run("mine"), run("theirs")],
			nextRuns: { mine: "2026-11-21T00:00:00Z", theirs: null },
		} as unknown as SchedulesState;
		const scoped = await scopedSchedules(state, inScope);
		expect(scoped.schedules.map(entry => entry.id)).toEqual(["mine"]);
		expect(scoped.runs.map(entry => entry.scheduleId)).toEqual(["mine"]);
		expect(scoped.nextRuns).toEqual({ mine: "2026-11-21T00:00:00Z" });
		expect(scoped.outside).toBe(1);
		expect(JSON.stringify(scoped)).not.toMatch(/theirs|repo\/b/);
		// Nothing left out: the state as it is, with no count.
		expect(await scopedSchedules(state, async () => true)).toBe(state);
	});
});
