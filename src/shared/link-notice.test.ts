import { describe, expect, it } from "vitest";
import { LINK_NOTICE_GRACE_MS, TAILSCALE_HINT_AFTER_MS, tailscaleHint } from "./link-notice";

describe("tailscaleHint", () => {
	const now = 1_000_000;
	const longAgo = now - TAILSCALE_HINT_AFTER_MS;

	it("stays quiet through a short outage, even with Tailscale down", () => {
		expect(tailscaleHint(now - LINK_NOTICE_GRACE_MS, "not-running", now)).toBe(false);
		expect(tailscaleHint(longAgo + 1, "not-running", now)).toBe(false);
	});

	it("asks to check Tailscale once a long outage meets this computer's Tailscale down", () => {
		expect(tailscaleHint(longAgo, "not-running", now)).toBe(true);
		expect(tailscaleHint(longAgo, "needs-login", now)).toBe(true);
		expect(tailscaleHint(longAgo, "not-installed", now)).toBe(true);
	});

	it("says nothing new when Tailscale is up: the host itself is off", () => {
		expect(tailscaleHint(longAgo, "ready", now)).toBe(false);
	});

	it("says nothing while this computer's Tailscale is unknown or the host is online", () => {
		expect(tailscaleHint(longAgo, undefined, now)).toBe(false);
		expect(tailscaleHint(undefined, "not-running", now)).toBe(false);
	});
});
