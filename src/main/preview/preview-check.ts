/**
 * Preview check: after `gui_visualize open` loads a page, the judge model looks at that one page and says whether
 * it shows an error message or nothing at all (resources/gui-bridge/modes/judge-assist-contracts.ts; the numbers:
 * 22 agent-made pages, error ≥ 0.5 or empty ≥ 0.8 found 13/13 broken pages with 0 false alarms, p50 409 ms).
 *
 * Only an addition: the judge answers while stock's `judge` role chain resolves first to a native decision model
 * and the `judgeAssist` pref is on. A switch that is off or no native judge ends as `null` here, so the tool answers
 * byte for byte as it did before and no notice shows. Once a native judge was there to ask, every way the page goes
 * unjudged (it never showed, the judge failed, did not decide or ran out of time) ends as `"unchecked"`, and the tool
 * says so: an agent never reads a page nobody looked at as a page with no problem.
 *
 * Privacy: the capture is `capturePage()` of the one preview page that shows the visual (main/preview/host.ts),
 * never the app window, another preview tab or a window of the user, and only while that page is on screen. It is
 * never a page the user browses: a visual is a page the agent just asked the Preview to show.
 */
import type {
	PreviewCheckResult,
	PreviewProblem as PreviewVerdict,
} from "../../../resources/gui-bridge/modes/judge-assist-contracts";
import type { RpcClient } from "../rpc-client";
import type { VisualPages } from "./visuals";

export type { PreviewVerdict };

/** The longer side of the picture sent to the judge; keeps the request small. */
export const PREVIEW_CHECK_IMAGE_MAX = 1280;
/** A page that finished loading paints its last frame within this long (late scripts, fonts, layout). */
export const PREVIEW_CHECK_SETTLE_MS = 300;
/**
 * What the judge keeps of the total, and the page gets the rest to appear, load and settle, because how long a window
 * takes to open its Preview is what varies: on GitHub's Windows runner the page was asked for 1.2 s after the tool
 * opened the visual and loaded at 1.6 s, and on a run's first open it was not even asked for at 2 s, so a flat 2 s for
 * the page dropped the check while 1.9 s of the total sat unused. The judge's real time on a picture is the 22 pages'
 * p50 of 409 ms above; a judge that needs longer than what is left makes the check `"unchecked"`, never silent.
 */
export const PREVIEW_CHECK_JUDGE_MS = 1000;
/**
 * `reveal` makes a window show the visual only when its tab is the one in front, so a tab behind never gets its page on
 * screen and the capture gives up on it after this long. A tab in front waits for the page as long as the total allows
 * instead: a busy window mounts its panel late (a renderer 4x slower had the page asked for and still not laid out
 * 450 ms after the tool opened it, and a flat 400 ms dropped the check).
 */
export const PREVIEW_CHECK_BEHIND_MS = 400;
/** The whole check (probe + page + settle + judge) holds the tool's answer at most this long. */
export const PREVIEW_CHECK_TOTAL_MS = 4000;
/**
 * Asking the tab's omp whether a native judge would answer at all; no answer in time counts as "no". The answer needs
 * no model call, but a busy omp on a slow machine (measured on a loaded CI runner) took past 500 ms, and a probe that
 * misses its bound turns the check off for that machine; the time it takes still comes out of the total.
 */
export const PREVIEW_CHECK_PROBE_MS = 1500;

export interface PreviewImage {
	data: string;
	mimeType: "image/png";
}

export interface PreviewCheckDeps {
	/** The `judgeAssist` pref: with the switch off nothing is captured. */
	enabled(): boolean;
	/**
	 * Whether the tab's omp has a native judge (stock `hasNativeJudge`, no model call). Without one the check ends here:
	 * no waiting for the page, no capture, so a user with the switch on but no native judge loses no time.
	 */
	available(budgetMs: number): Promise<boolean>;
	/** Whether the visual's tab is the one its window shows: only then does the window open the Preview for it. */
	inFront(): boolean;
	/**
	 * The visual's own page as a PNG once it is on screen and settled; null when there is none within `budgetMs`, or
	 * when no window has put it on screen within `appearMs`.
	 */
	capture(visualId: string, version: number, budgetMs: number, appearMs: number): Promise<PreviewImage | null>;
	/** The tab's omp judges the picture; null when the request failed. */
	judge(image: PreviewImage, budgetMs: number): Promise<PreviewCheckResult | null>;
	/** Show the quiet notice on the page that shows `version` of the visual. */
	flag(visualId: string, version: number, problem: PreviewVerdict): void;
}

/** What the judge saw, or `"unchecked"`: a native judge was there, but the page went unjudged. */
export type PreviewCheckOutcome = PreviewVerdict | "unchecked";

/** What the agent reads under the tool result; English because tool results are model-facing. */
export function previewHint(outcome: PreviewCheckOutcome): string {
	if (outcome === "unchecked")
		return "Preview check: could not check the page in time, so nobody has seen how it looks. Look at it with gui_visualize before you rely on it.";
	const seen = outcome === "error" ? "the page shows an error message." : "the page looks blank (nothing rendered).";
	return `Preview check: ${seen} Look at it with gui_visualize or fix the page.`;
}

/** `promise`'s value, or null once `ms` passed (its late answer is dropped). */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<null>(resolve => {
		timer = setTimeout(() => resolve(null), ms);
	});
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** The part of Electron's `NativeImage` the picture for the judge needs. */
export interface CapturedImage {
	isEmpty(): boolean;
	getSize(): { width: number; height: number };
	resize(options: { width: number; height: number; quality: "good" }): CapturedImage;
	toPNG(): Buffer;
}

/** The capture as a PNG whose longer side is at most `PREVIEW_CHECK_IMAGE_MAX`; null for an empty capture. */
export function judgeImage(image: CapturedImage): PreviewImage | null {
	// A page that is not painted (hidden, zero-sized) captures as nothing; that is no evidence of a blank page.
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	const longer = Math.max(width, height);
	const fitted =
		longer > PREVIEW_CHECK_IMAGE_MAX
			? image.resize({
					width: Math.max(1, Math.round((width * PREVIEW_CHECK_IMAGE_MAX) / longer)),
					height: Math.max(1, Math.round((height * PREVIEW_CHECK_IMAGE_MAX) / longer)),
					quality: "good",
				})
			: image;
	return { data: fitted.toPNG().toString("base64"), mimeType: "image/png" };
}

/**
 * What the judge saw on the page of `version` of `visualId`, within `PREVIEW_CHECK_TOTAL_MS`; on a problem the page
 * also gets its notice. Never rejects and never takes longer. `null`: no check was made (switch off, no native judge,
 * no answer from the probe in time) or the judge saw no problem; `"unchecked"`: a native judge was there, but the page
 * went unjudged.
 */
export async function checkVisualPage(
	deps: PreviewCheckDeps,
	visualId: string,
	version: number,
): Promise<PreviewCheckOutcome | null> {
	if (!deps.enabled()) return null;
	const started = Date.now();
	let asked = false;
	// After the deadline nothing more happens: the tool has replied, so no model call and no notice.
	let open = true;
	const decide = async (): Promise<{ outcome: PreviewCheckOutcome | null }> => {
		try {
			const available = await withDeadline(deps.available(PREVIEW_CHECK_PROBE_MS), PREVIEW_CHECK_PROBE_MS);
			if (available !== true) return { outcome: null };
			asked = true;
			const captureMs = PREVIEW_CHECK_TOTAL_MS - PREVIEW_CHECK_JUDGE_MS - (Date.now() - started);
			const appearMs = deps.inFront() ? captureMs : PREVIEW_CHECK_BEHIND_MS;
			const image = await deps.capture(visualId, version, captureMs, appearMs);
			if (!image || !open) return { outcome: "unchecked" };
			const result = await deps.judge(image, Math.max(0, PREVIEW_CHECK_TOTAL_MS - (Date.now() - started)));
			if (!result?.judged) return { outcome: "unchecked" };
			if (!result.problem || !open) return { outcome: null };
			deps.flag(visualId, version, result.problem);
			return { outcome: result.problem };
		} catch {
			return { outcome: asked ? "unchecked" : null };
		}
	};
	try {
		const decided = await withDeadline(decide(), PREVIEW_CHECK_TOTAL_MS);
		return decided ? decided.outcome : asked ? "unchecked" : null;
	} finally {
		open = false;
	}
}

/**
 * The check of a tab's visual: the pages of its window do the capture, the tab's own omp the judging (a local
 * command, main/local/judge-assist.ts: its judge, its quota). `rpc` is null while the tab's omp is not running.
 */
export function createTabCheck(options: {
	enabled: () => boolean;
	/** Whether the visual's tab is the one its window shows right now. */
	inFront: () => boolean;
	pages: Pick<VisualPages, "capture" | "flag">;
	rpc: Pick<RpcClient, "command"> | null;
}): (visualId: string, version: number) => Promise<PreviewCheckOutcome | null> {
	const { enabled, inFront, pages, rpc } = options;
	return (visualId, version) =>
		checkVisualPage(
			{
				enabled,
				inFront,
				available: async budgetMs => {
					const response = await rpc?.command({ type: "judge_available" }, budgetMs);
					return (
						response?.success === true &&
						(response.data as { available?: unknown } | undefined)?.available === true
					);
				},
				capture: (id, shown, budgetMs, appearMs) => pages.capture(id, shown, budgetMs, appearMs),
				judge: async (image, budgetMs) => {
					const response = await rpc?.command({ type: "judge_preview_check", image }, budgetMs);
					if (!response?.success) return null;
					const data = response.data as Partial<PreviewCheckResult> | undefined;
					const problem = data?.problem === "error" || data?.problem === "blank" ? data.problem : null;
					return { problem, judged: data?.judged === true };
				},
				flag: (id, shown, problem) => pages.flag(id, shown, problem),
			},
			visualId,
			version,
		);
}
