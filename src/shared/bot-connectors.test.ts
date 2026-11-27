import { describe, expect, it } from "vitest";
import { waitingAskers } from "./bot-connectors";
import type { ConnectorAsker, Schedule, ScheduleEvent } from "./schedules";

const schedule = (id: string, event: ScheduleEvent): Schedule =>
	({
		id,
		name: id,
		prompt: "",
		cwd: "/bot",
		model: null,
		autoApprove: false,
		enabled: true,
		createdAt: "2026-11-27T00:00:00.000Z",
		frequency: { kind: "event", event },
	}) as Schedule;

const asker = (person: string, at: string, declined?: boolean): ConnectorAsker => ({
	person,
	name: person,
	place: "Slack, a direct message",
	at,
	...(declined ? { declined } : {}),
});

describe("waitingAskers", () => {
	it("lists who still waits on the owner, newest first, never someone declined or let in since", () => {
		const slack = schedule("s", { source: "slack", account: "a", from: ["U1", "u3"] });
		const anyone = schedule("l", { source: "linear", account: "l", handle: "h", from: ["*"] });
		const github = schedule("g", { source: "github", repo: "o/r", events: ["comment"], ask: "h", from: ["ann"] });
		const waiting = waitingAskers([slack, anyone, github], {
			s: [
				asker("U2", "2026-11-27T01:00:00.000Z"),
				asker("U3", "2026-11-27T02:00:00.000Z"),
				asker("U4", "2026-11-27T03:00:00.000Z", true),
			],
			l: [asker("x@y.z", "2026-11-27T04:00:00.000Z")],
			g: [asker("eve", "2026-11-27T05:00:00.000Z")],
		});
		expect(waiting.map(({ connector, asker }) => `${connector.service}:${asker.person}`)).toEqual([
			"github:eve",
			"slack:U2",
		]);
	});
});
