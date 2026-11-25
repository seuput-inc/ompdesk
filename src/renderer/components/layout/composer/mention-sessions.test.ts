import { describe, expect, it } from "vitest";
import { sessionMentionItems, sessionMentionText } from "./mention-sessions";

const labels = { child: "Session this one opened", session: "Session in this project" };
const sessions = [
	{ id: "a1", title: "Fix the login form", child: true },
	{ id: "b2", title: "Release notes", child: false },
	{ id: "c3", title: "Login redirect", child: false },
];

describe("sessions in the @ menu", () => {
	it("offers every session for a bare @, children first, and filters by the typed words", () => {
		expect(sessionMentionItems(sessions, "", labels).map(item => item.label)).toEqual([
			"Fix the login form",
			"Release notes",
			"Login redirect",
		]);
		const login = sessionMentionItems(sessions, "login", labels);
		expect(login.map(item => [item.label, item.description, item.highlights])).toEqual([
			["Fix the login form", labels.child, [[8, 13]]],
			["Login redirect", labels.session, [[0, 5]]],
		]);
	});

	it("writes the title and the saved id every ompdesk_session tool takes", () => {
		expect(sessionMentionText({ id: "a1", title: "Fix the login form" })).toBe("session “Fix the login form” (a1) ");
		expect(sessionMentionItems(sessions, "release", labels)[0]?.value).toBe("session “Release notes” (b2) ");
	});
});
