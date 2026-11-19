/**
 * Rows ask the computer that runs each session what it works in: once per journal stamp (a tab's unstamped ask never
 * re-asks a row the list already asked about), the picture once per repository, and a failed call keeps the row on
 * its fallback until a later ask after the retry wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionArtworks, SessionTargetQuery, SessionTargets } from "../../shared/session-target";
import { resolveRowTarget } from "../components/layout/sidebar/session-row-target";
import { resetLastReadForTest } from "../lib/last-read";
import {
	requestSessionTargets,
	resetSessionTargetsForTest,
	TARGETS_RETRY_MS,
	targetKey,
	useSessionTargets,
} from "./session-targets";

const targets = vi.fn<(sessions: SessionTargetQuery[], device?: string) => Promise<SessionTargets>>();
const artwork = vi.fn<(roots: string[], device?: string) => Promise<SessionArtworks>>();
const PNG = "data:image/png;base64,AAAA";
const FALLBACK = { name: "app", artwork: null, head: null };

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { window: { omp: { sessions: { targets, artwork } } } });
});

afterEach(() => {
	resetSessionTargetsForTest();
	resetLastReadForTest();
	targets.mockReset();
	artwork.mockReset();
	vi.useRealTimers();
});

describe("session targets", () => {
	it("asks once per stamp, looks the picture up once per repository, and a row then reads branch and picture", async () => {
		targets.mockResolvedValue({
			"/s/a.jsonl": {
				path: "/repo/app",
				repository: { root: "/repo/app", name: "app" },
				head: { kind: "branch", name: "main" },
			},
			"/s/b.jsonl": {
				path: "/wt/x",
				repository: { root: "/repo/app", name: "app" },
				head: { kind: "detached", commit: "0123456789abcdef" },
			},
		});
		artwork.mockResolvedValue({ "/repo/app": { src: PNG, source: "owner" } });
		const rows = [
			{ sessionPath: "/s/a.jsonl", cwd: "/repo/app", stamp: "1" },
			{ sessionPath: "/s/b.jsonl", cwd: "/wt/x", stamp: "1" },
		];
		requestSessionTargets("host", rows);
		await vi.advanceTimersByTimeAsync(0);
		// The same rows again, and a tab's unstamped ask for one of them: nothing new to ask.
		requestSessionTargets("host", rows);
		requestSessionTargets("host", [{ sessionPath: "/s/a.jsonl", cwd: "/repo/app" }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(targets).toHaveBeenCalledTimes(1);
		expect(targets.mock.calls[0]?.[1]).toBe("host");
		expect(artwork).toHaveBeenCalledTimes(1);
		expect(artwork.mock.calls[0]).toEqual([["/repo/app"], "host"]);

		const state = useSessionTargets.getState();
		expect(resolveRowTarget(state, "host", "/s/a.jsonl", FALLBACK)).toEqual({
			name: "app",
			artwork: PNG,
			head: { kind: "branch", name: "main" },
		});
		expect(resolveRowTarget(state, "host", "/s/b.jsonl", FALLBACK).head).toEqual({
			kind: "detached",
			commit: "0123456789abcdef",
		});
		// Another computer's session at the same path is not this one's.
		expect(resolveRowTarget(state, undefined, "/s/a.jsonl", FALLBACK)).toBe(FALLBACK);

		// A newer journal stamp asks again.
		requestSessionTargets("host", [{ ...rows[0], stamp: "2" }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(targets).toHaveBeenCalledTimes(2);
	});

	it("keeps a row on its fallback when the computer cannot answer, and asks again only after the wait", async () => {
		targets.mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "unsupported" }));
		const row = { sessionPath: "/s/a.jsonl", cwd: "/repo/app", stamp: "1" };
		requestSessionTargets(undefined, [row]);
		await vi.advanceTimersByTimeAsync(0);
		expect(useSessionTargets.getState().targets[targetKey(undefined, row.sessionPath)]).toBeUndefined();
		requestSessionTargets(undefined, [row]);
		expect(targets).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(TARGETS_RETRY_MS);
		targets.mockResolvedValueOnce({ [row.sessionPath]: null });
		requestSessionTargets(undefined, [row]);
		await vi.advanceTimersByTimeAsync(0);
		expect(targets).toHaveBeenCalledTimes(2);
		// A folder that is gone keeps its letter mark and shows no branch.
		expect(
			resolveRowTarget(useSessionTargets.getState(), undefined, row.sessionPath, {
				name: "app",
				artwork: null,
				head: { kind: "branch", name: "stale" },
			}),
		).toEqual({ name: "app", artwork: null, head: null });
	});
});
