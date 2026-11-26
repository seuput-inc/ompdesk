/**
 * The offer after a freeze or a crash loop: one toast whose Report opens the feedback dialog with the record as its
 * captured error, taken from prefs once (cleared at once, so another window or launch does not offer it again).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCH_INCIDENT_PREF, type LaunchIncident } from "../../../shared/launch-incident";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { LaunchIncidentNotice } from "./LaunchIncidentNotice";

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

const prefs = new Map<string, unknown>();
let root: Root | null = null;

const HANG: LaunchIncident = { kind: "hang", at: 1, detail: "main-thread-hang\nMain thread stalled for 12s" };

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<LaunchIncidentNotice />
			</I18nProvider>,
		);
	});
}

beforeEach(() => {
	prefs.clear();
	Object.assign(window as unknown as Record<string, unknown>, {
		omp: {
			prefs: {
				get: (key: string) => Promise.resolve(prefs.get(key) ?? null),
				set: (key: string, value: unknown) => {
					prefs.set(key, value);
					return Promise.resolve();
				},
			},
		},
	});
	useToastStore.setState({ toasts: [] });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	useToastStore.setState({ toasts: [] });
	useUiStore.setState({ feedbackOpen: false, feedbackPrefill: null });
});

describe("LaunchIncidentNotice", () => {
	it("offers a freeze once and opens feedback with its record", async () => {
		prefs.set(LAUNCH_INCIDENT_PREF, HANG);
		await mount();
		const [offer] = useToastStore.getState().toasts;
		expect(offer?.message).toBe(translate("launchIncident.hang"));
		expect(prefs.get(LAUNCH_INCIDENT_PREF)).toBeNull();
		offer?.action?.run();
		expect(useUiStore.getState().feedbackOpen).toBe(true);
		expect(useUiStore.getState().feedbackPrefill).toEqual({
			title: translate("launchIncident.hangTitle"),
			error: HANG.detail,
		});
	});

	it("offers nothing after a clean launch", async () => {
		await mount();
		expect(useToastStore.getState().toasts).toEqual([]);
	});
});
