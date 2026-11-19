/**
 * Settings › Updates & about › This computer › omp updates: the one "Keep tools up to date" switch is on by
 * default (state's `enabled`) and writes the `toolsAutoUpdate` pref, "Update now"
 * asks main and is off while an update runs, the status line says what main
 * learned from npm, and a failed attempt keeps its reason and the retry note.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpUpdateState } from "../../../shared/omp-update";
import { I18nProvider, translate } from "../../lib/i18n";
import { ko } from "../../locales/ko";
import { useOmpUpdateStore } from "../../stores/omp-update";
import { OmpUpdateNowButton, OmpUpdateRows, OmpUpdateStatus } from "./OmpUpdateRows";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

function ompUpdateState(partial: Partial<OmpUpdateState> = {}): OmpUpdateState {
	return {
		enabled: true,
		scheduled: true,
		phase: "idle",
		installed: "18.8.7",
		latest: "18.8.7",
		checkedAt: 1,
		updatedTo: null,
		failure: null,
		...partial,
	};
}

let listener: ((state: OmpUpdateState) => void) | null = null;
const current = { state: ompUpdateState() };
const api = {
	getState: vi.fn(async () => current.state),
	now: vi.fn(async () => {}),
	onState: vi.fn((callback: (state: OmpUpdateState) => void) => {
		listener = callback;
		return () => {
			listener = null;
		};
	}),
};
const prefsSet = vi.fn(async (_key: string, _value: unknown) => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { ompUpdate: api, prefs: { get: async () => undefined, set: prefsSet } },
});

let root: Root | null = null;
async function mount(state: OmpUpdateState): Promise<void> {
	current.state = state;
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<OmpUpdateRows />
				<OmpUpdateNowButton />
				<OmpUpdateStatus />
			</I18nProvider>,
		),
	);
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
const push = (state: OmpUpdateState) =>
	act(async () => {
		listener?.(state);
	});
const toggle = () => document.body.querySelector("#setting-gui-toolsAutoUpdate [role='switch']") as HTMLElement;
const nowButton = () => document.body.querySelector("[data-testid='omp-update-now']") as HTMLButtonElement;
const status = () => document.body.querySelector("[data-testid='omp-update-status']")?.textContent;
const testedNote = () => document.body.querySelector("[data-testid='omp-tested']")?.textContent;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useOmpUpdateStore.getState().reset();
	for (const fn of [...Object.values(api), prefsSet]) fn.mockClear();
});

describe("OmpUpdateRows", () => {
	it("shows one 'Keep tools up to date' switch on by default, says nothing while omp is current, and turns all three off", async () => {
		await mount(ompUpdateState());
		expect(translate("toolsUpdate.auto")).toBe("Keep tools up to date");
		expect(document.body.textContent).toContain(translate("toolsUpdate.auto"));
		expect(document.body.querySelector("#setting-gui-ompAutoUpdate")).toBeNull();
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		expect(status()).toBeUndefined();
		await act(async () => toggle().click());
		expect(prefsSet).toHaveBeenCalledWith("toolsAutoUpdate", false);
		// Main pushes the new state after the pref change.
		await push(ompUpdateState({ enabled: false }));
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("asks main to update now, and offers it only while nothing runs", async () => {
		await mount(ompUpdateState({ latest: "18.9.0" }));
		expect(status()).toBe(translate("ompUpdate.status.available", { version: "18.8.7", latest: "18.9.0" }));
		await act(async () => nowButton().click());
		expect(api.now).toHaveBeenCalledTimes(1);
		await push(ompUpdateState({ latest: "18.9.0", phase: "updating" }));
		expect(nowButton().disabled).toBe(true);
		expect(status()).toBe(translate("ompUpdate.status.updating"));
		await push(ompUpdateState({ phase: "checking" }));
		expect(nowButton().disabled).toBe(true);
		expect(status()).toBe(translate("ompUpdate.status.checking"));
	});

	it("keeps a failed attempt's reason and says the next check retries", async () => {
		await mount(
			ompUpdateState({
				latest: "18.9.0",
				failure: { reason: "install", detail: "exit 1 — EBUSY: resource busy or locked" },
			}),
		);
		const notice = document.body.querySelector("[data-inline-notice='warning']");
		expect(notice?.textContent).toContain(translate("ompUpdate.failure.install"));
		expect(notice?.textContent).toContain(translate("ompUpdate.retryNote"));
		expect(notice?.textContent).toContain("EBUSY: resource busy or locked");
	});

	it("keeps Update now for a build that never checks on its own", async () => {
		await mount(ompUpdateState({ scheduled: false, latest: null }));
		expect(nowButton().disabled).toBe(false);
	});

	it("names the tested omp only while another omp is installed (a host that sends no verified list)", async () => {
		await mount(ompUpdateState({ installed: "18.22.0", latest: "18.22.0", tested: "18.22.0" }));
		expect(document.body.querySelector("[data-testid='omp-tested']")).toBeNull();
		await push(ompUpdateState({ installed: "18.23.0", latest: "18.23.0", tested: "18.22.0" }));
		expect(document.body.querySelector("[data-testid='omp-tested']")?.textContent).toBe(
			translate("ompUpdate.tested", { version: "18.22.0" }),
		);
	});

	it("says nothing for a verified omp, and says when the running omp has not passed this release's checks", async () => {
		const tested = document.body.querySelector.bind(document.body, "[data-testid='omp-tested']");
		await mount(ompUpdateState({ installed: "19.0.0", latest: "19.0.0", tested: "18.22.2", verified: ["19.0.0"] }));
		expect(tested()).toBeNull();
		// A person ran `omp update` in a terminal: the omp that runs is on no list.
		await push(ompUpdateState({ installed: "19.1.0", latest: "19.1.0", tested: "18.22.2", verified: ["19.0.0"] }));
		expect(tested()?.textContent).toBe(translate("ompUpdate.unverified", { version: "19.1.0", tested: "18.22.2" }));
	});

	it("says a newer omp waits for the checks, keeps Update now as the way to install it, and goes quiet once it is installed", async () => {
		const held = { version: "19.0.0", reason: "verifying" } as const;
		const heldNote = () => document.body.querySelector("[data-testid='omp-update-held']")?.textContent;
		await mount(ompUpdateState({ installed: "18.22.2", latest: "19.0.0", tested: "18.22.2", verified: [], held }));
		expect(heldNote()).toBe(translate("ompUpdate.held.verifying", { latest: "19.0.0" }));
		expect(heldNote()).toContain("19.0.0");
		// One line says it: no "is available" beside it.
		expect(status()).toBeUndefined();
		expect(nowButton().disabled).toBe(false);
		await act(async () => nowButton().click());
		expect(api.now).toHaveBeenCalledTimes(1);
		// The person's update runs: the status line speaks, the held line steps back.
		await push(
			ompUpdateState({ installed: "18.22.2", latest: "19.0.0", tested: "18.22.2", held, phase: "updating" }),
		);
		expect(status()).toBe(translate("ompUpdate.status.updating"));
		expect(heldNote()).toBeUndefined();
		await push(
			ompUpdateState({ installed: "19.0.0", latest: "19.0.0", tested: "18.22.2", verified: [], held: null }),
		);
		expect(heldNote()).toBeUndefined();
		expect(testedNote()).toBe(translate("ompUpdate.unverified", { version: "19.0.0", tested: "18.22.2" }));
	});

	it("says an unverified omp may not work with every feature, in English and Korean, beside a held line too", async () => {
		const unverified = { installed: "19.0.0", tested: "18.22.2", verified: [] };
		await mount(ompUpdateState({ ...unverified, latest: "19.0.0" }));
		expect(testedNote()).toBe(
			"omp 19.0.0 hasn't passed OMPdesk's checks for this release (tested with omp 18.22.2). Some features may not work.",
		);
		expect(ko["ompUpdate.unverified"]).toBe(
			"지금 쓰는 omp {version} 판은 이 OMPdesk에서 아직 검사를 통과하지 않았어요(omp {tested}에서 검증됨). 일부 기능이 동작하지 않을 수 있어요.",
		);
		// A newer release is held as well: the held line and this one both stay.
		const held = { version: "19.0.1", reason: "verifying" } as const;
		await push(ompUpdateState({ ...unverified, latest: "19.0.1", held }));
		expect(document.body.querySelector("[data-testid='omp-update-held']")?.textContent).toBe(
			translate("ompUpdate.held.verifying", { latest: "19.0.1" }),
		);
		expect(testedNote()).toBe(translate("ompUpdate.unverified", { version: "19.0.0", tested: "18.22.2" }));
		expect(status()).toBeUndefined();
	});

	it("reads a host on OMPdesk 0.134, which sends no verified list, by the tested major", async () => {
		const onNewerMajor = { installed: "19.0.0", tested: "18.22.2" };
		const held = { version: "19.0.1", reason: "untested-major" } as const;
		await mount(ompUpdateState({ ...onNewerMajor, latest: "19.0.1", held }));
		expect(document.body.querySelector("[data-testid='omp-update-held']")?.textContent).toBe(
			translate("ompUpdate.held.untested-major", { latest: "19.0.1", tested: "18.22.2" }),
		);
		expect(testedNote()).toBe(translate("ompUpdate.unverified", { version: "19.0.0", tested: "18.22.2" }));
		// Inside the tested major the line stays the plain fact.
		await push(ompUpdateState({ installed: "18.23.0", latest: "18.23.0", tested: "18.22.2" }));
		expect(testedNote()).toBe(translate("ompUpdate.tested", { version: "18.22.2" }));
	});

	it("says an omp the checks failed stays held, and for how many days", async () => {
		const heldNote = () => document.body.querySelector("[data-testid='omp-update-held']")?.textContent;
		const state = { installed: "18.22.2", latest: "19.0.0", tested: "18.22.2", verified: [] };
		const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 60_000).toISOString();
		await mount(ompUpdateState({ ...state, held: { version: "19.0.0", reason: "failed", since } }));
		expect(heldNote()).toBe(
			translate("ompUpdate.held.failedDays", { latest: "19.0.0", installed: "18.22.2", days: 3 }),
		);
		await push(
			ompUpdateState({ ...state, held: { version: "19.0.0", reason: "failed", since: new Date().toISOString() } }),
		);
		expect(heldNote()).toBe(translate("ompUpdate.held.failed", { latest: "19.0.0", installed: "18.22.2" }));
	});

	it("says omp's own auto-update is off only while OMPdesk holds it", async () => {
		const note = () => document.body.querySelector("[data-testid='omp-stock-auto-taken']")?.textContent;
		await mount(ompUpdateState({ stockAutoTaken: false }));
		expect(note()).toBeUndefined();
		await push(ompUpdateState({ stockAutoTaken: true }));
		expect(note()).toBe(translate("ompUpdate.stockAutoTaken"));
	});
});
