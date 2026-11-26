import { describe, expect, it } from "vitest";
import { openedPullRequest } from "./work-view";

describe("openedPullRequest", () => {
	it("reads the URL `gh pr create` printed, on github.com and an Enterprise host", () => {
		const printed = "Creating pull request for feat into main in o/r\n\nhttps://github.com/o/r/pull/12\n";
		expect(openedPullRequest("gh pr create --fill", printed)).toBe("https://github.com/o/r/pull/12");
		expect(openedPullRequest("cd app && gh  pr create -t x", "https://ghe.test/o/r/pull/3")).toBe(
			"https://ghe.test/o/r/pull/3",
		);
	});

	it("ignores PR links another command only mentions", () => {
		expect(openedPullRequest("gh pr list", "#12 https://github.com/o/r/pull/12")).toBeNull();
		expect(openedPullRequest("git push", "remote: https://github.com/o/r/pull/new/feat")).toBeNull();
		expect(openedPullRequest("gh pr create", "a pull request already exists")).toBeNull();
	});
});
