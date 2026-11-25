import { describe, expect, it } from "vitest";
import { githubItemLink, sessionLink, sessionLinkLabel } from "./session-links";

describe("sessionLink", () => {
	it("reads a pull request or an issue on any host, with its repository and number", () => {
		expect(sessionLink(" https://github.com/acme/api/pull/12/files ")).toEqual({
			url: "https://github.com/acme/api/pull/12/files",
			kind: "pr",
			repo: "acme/api",
			number: 12,
		});
		expect(sessionLink("https://ghe.example.com/acme/api/issues/7#issuecomment-1")).toEqual({
			url: "https://ghe.example.com/acme/api/issues/7#issuecomment-1",
			kind: "issue",
			repo: "acme/api",
			number: 7,
		});
		expect(
			sessionLinkLabel({ url: "https://github.com/acme/api/pull/12", kind: "pr", repo: "acme/api", number: 12 }),
		).toBe("acme/api#12");
	});

	it("keeps any other https page as a plain link, normalized", () => {
		expect(sessionLink("https://Example.com")).toEqual({ url: "https://example.com/", kind: "url" });
		expect(sessionLink("https://github.com/acme/api/pulls")).toEqual({
			url: "https://github.com/acme/api/pulls",
			kind: "url",
		});
	});

	it("refuses anything that is no https URL, or one carrying credentials", () => {
		for (const raw of [
			"",
			"acme/api#12",
			"http://github.com/acme/api/pull/12",
			"ftp://example.com/a",
			"javascript:alert(1)",
			"https://user:pw@example.com/",
		])
			expect(sessionLink(raw), raw).toBeNull();
	});

	it("leaves the link peek's reading as it was (http allowed, github.com without a host)", () => {
		expect(githubItemLink("http://www.github.com/acme/api/issues/3")).toEqual({ repo: "acme/api", number: 3 });
		expect(githubItemLink("https://ghe.example.com/acme/api/pull/3")).toEqual({
			host: "ghe.example.com",
			repo: "acme/api",
			number: 3,
		});
	});
});
