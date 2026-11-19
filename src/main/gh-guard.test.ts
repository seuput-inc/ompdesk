import { describe, expect, it } from "vitest";
import {
	belowFloor,
	classify,
	parseRateLimit,
	QUOTA_FLOOR,
	readingStale,
	refusal,
	watchArgs,
} from "../../resources/gui-bridge/gh-guard-core";

const kind = (command: string) => {
	const call = classify(command.split(" "));
	return call.kind === "log"
		? `log${call.wide ? " wide" : ""}`
		: call.kind === "free"
			? "free"
			: `${call.kind} ${call.resource}`;
};

describe("what a gh command costs", () => {
	it.each([
		["run list --limit 50", "wide core"],
		["run download 1", "wide core"],
		["api --paginate repos/o/r/actions/runs", "wide core"],
		["pr list", "wide graphql"],
		["issue list --state open", "wide graphql"],
		["api graphql --paginate -f query=x", "wide graphql"],
		["run view 1 --log", "log wide"],
		["api repos/o/r/actions/runs/1/logs", "log wide"],
		["run view 1 --log-failed", "log"],
		["run view --job 5 --log", "log"],
		["api --allow-escape-sequences repos/{owner}/{repo}/actions/jobs/5/logs", "log"],
		["api repos/o/r/actions/jobs/5/logs --jq .", "narrow core"],
		["run view 1 --json status,jobs", "narrow core"],
		["workflow run ci.yml --ref main", "narrow core"],
		["api --method POST repos/o/r/actions/workflows/ci.yml/dispatches", "narrow core"],
		["pr merge 7 --squash", "narrow graphql"],
		["api rate_limit", "free"],
		["auth status", "free"],
		["--version", "free"],
	])("%s: %s", (command, expected) => {
		expect(kind(command)).toBe(expected);
	});

	it("keys a run's log by its attempt only when the command names one", () => {
		expect(classify(["run", "view", "9", "--log-failed", "--attempt", "1", "-R", "o/r"])).toMatchObject({
			log: { of: "run", run: "9", attempt: 1, mode: "log-failed", repo: "o/r" },
		});
		expect(classify(["run", "view", "https://github.com/o/r/actions/runs/9", "--log"])).toMatchObject({
			log: { of: "run", run: "9", mode: "log" },
		});
		expect(classify(["run", "view", "9", "--log"])).not.toHaveProperty("log.attempt");
	});
});

describe("a watch", () => {
	it("refreshes at most once a minute, a slower one as asked", () => {
		expect(watchArgs(["run", "watch", "1"])).toEqual(["run", "watch", "1", "--interval", "60"]);
		expect(watchArgs(["run", "watch", "1", "-i", "5"])).toEqual(["run", "watch", "1", "-i", "60"]);
		expect(watchArgs(["run", "watch", "1", "--interval=10"])).toEqual(["run", "watch", "1", "--interval=60"]);
		expect(watchArgs(["run", "watch", "1", "-i3"])).toEqual(["run", "watch", "1", "-i60"]);
		expect(watchArgs(["run", "watch", "1", "--interval", "120"])).toEqual(["run", "watch", "1", "--interval", "120"]);
		expect(classify(["pr", "checks", "7", "--watch"])).toMatchObject({ kind: "watch", resource: "graphql" });
	});
});

describe("the quota reading", () => {
	const now = Date.UTC(2026, 10, 19, 21, 33);
	const reset = now / 1000 + 780;
	const reading = parseRateLimit(
		JSON.stringify({
			resources: {
				core: { limit: 5000, remaining: 0, reset },
				graphql: { limit: 5000, remaining: 4638, reset },
				search: { limit: 30, remaining: 30, reset },
			},
		}),
		now,
	);

	it("judges each resource by its own floor", () => {
		expect(belowFloor(reading, "core")).toBe(true);
		expect(belowFloor(reading, "graphql")).toBe(false);
		expect(belowFloor({ at: now, core: { limit: 5000, remaining: QUOTA_FLOOR, reset } }, "core")).toBe(false);
		expect(belowFloor(undefined, "core")).toBe(false);
	});

	it("is read again after a minute, or once a resource has reset", () => {
		expect(readingStale(reading, now + 59_000)).toBe(false);
		expect(readingStale(reading, now + 60_000)).toBe(true);
		expect(readingStale({ at: now, core: { limit: 5000, remaining: 0, reset: now / 1000 + 10 } }, now + 11_000)).toBe(
			true,
		);
		expect(readingStale(undefined, now)).toBe(true);
	});

	it("refuses with what is left of both resources, the reset and the narrow read still allowed", () => {
		if (!reading) throw new Error("no reading");
		const text = refusal(["run", "list"], "core", reading);
		expect(text).toContain("`gh run list`");
		expect(text).toContain("core 0 of 5000 left, resets");
		expect(text).toContain("graphql 4638 of 5000 left");
		expect(text).toContain(new Date(reset * 1000).toISOString().replace(/\.\d+Z$/, "Z"));
		expect(text).toContain("gh run view <run> --log-failed");
		expect(text).toContain("an error, not an empty result");
	});
});
