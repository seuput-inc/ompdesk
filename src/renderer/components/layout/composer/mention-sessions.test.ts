import { afterEach, describe, expect, it } from "vitest";
import type { Bot } from "../../../../shared/bots";
import { useBotsFeature } from "../../../lib/bots-source";
import { useBotsStore } from "../../../stores/bots";
import { botMentionItems, sessionMentionItems, sessionMentionText } from "./mention-sessions";

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

describe("bots in the @ menu", () => {
	const bot = (id: string, name: string, over: Partial<Bot> = {}): Bot => ({
		id,
		name,
		folder: `/b/${id}`,
		home: `/s/${id}.jsonl`,
		sessions: [],
		paused: false,
		model: null,
		autoApprove: false,
		reach: [],
		staleDays: 7,
		lookAround: null,
		tidy: null,
		quiet: [],
		createdAt: "2026-11-01T00:00:00.000Z",
		...over,
	});
	afterEach(() => {
		useBotsFeature.setState({ available: true });
		useBotsStore.getState().reset();
	});

	it("finds a bot by name or purpose, writes the address its home chat takes, and says when it is paused", () => {
		useBotsStore.setState({
			state: {
				bots: [bot("r", "Rex", { specialty: "Reviews pull requests." }), bot("s", "Scout", { paused: true })],
				items: [],
			},
		});
		const labels = { paused: "Paused", bot: "Bot" };
		useBotsFeature.setState({ available: false });
		expect(botMentionItems("", labels)).toEqual([]);
		useBotsFeature.setState({ available: true });
		expect(botMentionItems("pull", labels).map(item => [item.label, item.value])).toEqual([
			["Rex", "bot “Rex” (bot:Rex) "],
		]);
		expect(botMentionItems("sc", labels).map(item => [item.label, item.description, item.highlights])).toEqual([
			["Scout", "Paused", [[0, 2]]],
		]);
	});
});
