/**
 * One-time feature tips: the first unseen tip shows once the session is ready and the getting-started guide is done
 * or hidden, counts as seen once on screen, and Try it goes to the feature; none shows while a person is still
 * getting started.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { STARTER_STEPS, useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { FeatureTipCard } from "./FeatureTipCard";

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
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
const stored: Record<string, unknown> = {};
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		prefs: {
			get: vi.fn(async (key: string) => stored[key]),
			set: vi.fn(async (key: string, value: unknown) => {
				stored[key] = value;
			}),
		},
	},
});

let root: Root | undefined;

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<FeatureTipCard />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

const tip = () => document.querySelector("[data-feature-tip]") as HTMLElement | null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	for (const key of Object.keys(stored)) delete stored[key];
	useStarterGuideStore.getState().reset();
	useSessionStore.setState({ status: "starting" });
	useUiStore.setState({ destination: "session", whatsNewCard: null });
});

describe("FeatureTipCard", () => {
	it("offers the first unseen tip once the guide is done, marks it seen, and Try it goes there", async () => {
		stored.starterGuide = { done: [...STARTER_STEPS], dismissed: false, toursSeen: [], tipsSeen: [] };
		useSessionStore.setState({ status: "ready" });
		await mount();
		expect(tip()?.getAttribute("data-feature-tip")).toBe("board");
		expect(tip()?.textContent).toContain(translate("tip.board.title"));
		expect(useStarterGuideStore.getState().tipsSeen).toEqual(["board"]);
		const tryIt = document.querySelector("[data-feature-tip-try]") as HTMLElement | null;
		await act(async () => tryIt?.click());
		expect(useUiStore.getState().destination).toBe("board");
	});

	it("shows none while the person is still getting started", async () => {
		stored.starterGuide = { done: ["model"], dismissed: false, toursSeen: [], tipsSeen: [] };
		useSessionStore.setState({ status: "ready" });
		await mount();
		expect(tip()).toBeNull();
	});
});
