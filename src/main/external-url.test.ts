import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";

let fixture: ShellPolicyFixture;
beforeAll(async () => {
	fixture = await shellPolicyFixture();
}, 180_000);
afterAll(async () => fixture?.close());

describe("page external URL policy", () => {
	it("admits web prefixes and mail drafts before native URL validation", async () => {
		for (const url of [
			"https://example.com/a?b=1",
			"http://localhost:3000",
			"https://",
			'https://example.com/"',
			"mailto:dev@example.com",
			"MAILTO:dev@example.com?subject=Hi%20there",
			"mAiLtO:?subject=Hi",
			"mailto:a\u200bb",
		]) {
			expect(await fixture.call("page.allowsExternal", { url }), url).toBe(true);
		}
	});

	it("refuses every other scheme and malformed mail links", async () => {
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"local://plan.md",
			"vscode://open",
			"HTTPS://example.com",
			"ms-settings:privacy-microphone",
			" mailto:a",
			"mailto:",
			"mailto:a b@example.com",
			"mailto:a@example.com\nbcc:x",
			"mailto:a\u00a0b",
			"mailto:a\ufeffb",
			"mailto:a\u2028b",
			"mailto:a\u009fb",
			"mailto:a\u0000",
			42,
			undefined,
		]) {
			expect(await fixture.call("page.allowsExternal", { url }), String(url)).toBe(false);
		}
	});
});
