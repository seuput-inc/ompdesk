import { afterEach, describe, expect, it } from "vitest";
import type { RpcPromptCacheStatus } from "../../shared/rpc-types";
import { promptCacheText } from "./context-usage";
import { setLanguageOverride, translate } from "./i18n";

afterEach(() => setLanguageOverride(null));

const NOW = Date.UTC(2026, 10, 25, 7, 0, 0);
const warm = (touchedAgoMs: number, ttlMs: number | undefined, extra: Partial<RpcPromptCacheStatus> = {}) =>
	({ state: "warm", inferred: false, touchedAt: NOW - touchedAgoMs, ttlMs, ...extra }) satisfies RpcPromptCacheStatus;

describe("promptCacheText", () => {
	it("says how long stock's warm entry is kept, and names no time for one that never expires", () => {
		setLanguageOverride("en");
		expect(promptCacheText(warm(60_000, 300_000), NOW, translate)).toMatch(/^Prompt cache kept until .+ · 4m left$/);
		expect(promptCacheText(warm(60_000, 300_000, { inferred: true }), NOW, translate)).toMatch(/likely kept/);
		expect(promptCacheText(warm(60_000, undefined), NOW, translate)).toBe("Prompt cache kept, no expiry");
	});

	it("reads a warm entry past its lifetime as refreshing, never as expired before stock says so", () => {
		setLanguageOverride("en");
		const held = warm(400_000, 300_000, { warming: { state: "refreshing" } });
		expect(promptCacheText(held, NOW, translate)).toBe("Prompt cache refreshing");
	});

	it("words stock's cold reasons: an expiry at its time, any other change as the request having changed", () => {
		setLanguageOverride("ko");
		const expired: RpcPromptCacheStatus = {
			...warm(0, 300_000),
			state: "cold",
			reason: { kind: "expired", at: NOW },
		};
		expect(promptCacheText(expired, NOW, translate)).toMatch(/^프롬프트 캐시가 .+에 만료됨/);
		const changed: RpcPromptCacheStatus = { ...warm(0, 300_000), state: "cold", reason: { kind: "model" } };
		expect(promptCacheText(changed, NOW, translate)).toBe("프롬프트 캐시 없음: 마지막 응답 뒤로 요청이 바뀌었어요");
	});
});
