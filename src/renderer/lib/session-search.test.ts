import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../shared/ipc-types";
import { rankSessions, splitSessionQuery } from "./session-search";

function row(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `/s/${id}.jsonl`,
		id,
		title: id,
		cwd: "/work",
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		messageCount: 2,
		size: 10,
		status: "complete",
		firstMessage: "hello",
		...overrides,
	};
}

describe("rankSessions", () => {
	it("finds a renamed session by its automatic title as well as by the name", () => {
		const renamed = row("renamed", { title: "Release prep", autoTitle: "Fix the login redirect" });
		const other = row("other");
		expect(rankSessions([other, renamed], "login redirect")).toEqual([renamed]);
		expect(rankSessions([other, renamed], "release")).toEqual([renamed]);
	});

	it("narrows by repo: and path: before ranking the free text", () => {
		const app = row("app", { cwd: "/code/acme/app", firstMessage: "fix login" });
		const site = row("site", { cwd: "/code/acme/site", firstMessage: "fix login" });
		const other = row("other", { cwd: "/code/zeta/tool", firstMessage: "fix login" });
		expect(rankSessions([app, site, other], "repo:ACME/APP login")).toEqual([app]);
		expect(rankSessions([app, site, other], 'path:"acme/" repo:site')).toEqual([site]);
		expect(rankSessions([app, site, other], "path:zeta", "recent", () => "anything")).toEqual([other]);
		expect(rankSessions([app, site, other], "repo:nowhere")).toEqual([]);
	});
});

describe("splitSessionQuery", () => {
	it("keeps operator-looking text inside a word literal and drops empty operators", () => {
		expect(splitSessionQuery('myrepo:x "a b" path: repo:"Acme App" https://h/path:x')).toEqual({
			text: 'myrepo:x "a b" https://h/path:x',
			repo: ["acme app"],
			path: [],
		});
	});
});
