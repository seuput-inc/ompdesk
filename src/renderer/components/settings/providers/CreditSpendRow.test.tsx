/**
 * Settings › Models & accounts › Credit use: reads the machine's switch (off unless stored on), saves a change through
 * `window.omp.creditSpend` (to the paired host when `device` names one), puts the old state back with a toast when a
 * save fails, and shows no row when the machine can't answer. Auto top-up is one line with a link to each provider's
 * own page: pressing one opens that page and sets nothing.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditSpendState } from "../../../../shared/credit-spend";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useToastStore } from "../../../stores/toast";
import { CreditSpendRow } from "./CreditSpendRow";

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

let state: CreditSpendState;
let failSet = false;
const creditSpend = {
	get: vi.fn(async (_device?: string): Promise<CreditSpendState> => state),
	set: vi.fn(async (enabled: boolean, _device?: string): Promise<CreditSpendState> => {
		if (failSet) throw new Error("bridge down");
		state = { enabled };
		return state;
	}),
};
const openExternal = vi.fn(async (_url: string) => {});
Object.assign(window as unknown as Record<string, unknown>, { omp: { creditSpend, system: { openExternal } } });

const roots: Root[] = [];

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

async function mount(device?: string): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<CreditSpendRow device={device} />
			</I18nProvider>,
		);
	});
	await settle();
	roots.push(root);
}

function toggle(): HTMLButtonElement {
	const button = document.body.querySelector('[data-credit-spend] [role="switch"]') as HTMLButtonElement | null;
	if (!button) throw new Error("credit use switch missing");
	return button;
}

const shown = () => document.body.querySelector("[data-credit-spend]")?.getAttribute("data-credit-spend");

beforeEach(() => {
	state = { enabled: false };
	failSet = false;
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	vi.clearAllMocks();
});

describe("CreditSpendRow", () => {
	it("shows this device's switch off with what each state does and the top-up sentence, and turns it on", async () => {
		await mount();
		expect(creditSpend.get).toHaveBeenCalledWith(undefined);
		expect(shown()).toBe("off");
		expect(toggle().getAttribute("aria-checked")).toBe("false");
		const text = document.body.textContent ?? "";
		expect(text).toContain(translate("providers.creditSpend.label"));
		expect(text).toContain(translate("providers.creditSpend.desc"));
		expect(text).toContain(translate("providers.creditSpend.topUp"));
		await act(async () => {
			toggle().click();
		});
		await settle();
		expect(creditSpend.set).toHaveBeenCalledWith(true, undefined);
		expect(shown()).toBe("on");
		expect(toggle().getAttribute("aria-checked")).toBe("true");
	});

	it("opens each provider's own billing page from the top-up line and touches no setting", async () => {
		await mount();
		const links = [...document.body.querySelectorAll("[data-credit-top-up] button")] as HTMLButtonElement[];
		expect(links.map(link => link.textContent)).toEqual(["ChatGPT", "Claude"]);
		expect(links.map(link => link.getAttribute("aria-label"))).toEqual([
			translate("providers.creditSpend.topUpOpen", { provider: "ChatGPT" }),
			translate("providers.creditSpend.topUpOpen", { provider: "Claude" }),
		]);
		for (const link of links) {
			await act(async () => {
				link.click();
			});
		}
		expect(openExternal.mock.calls).toEqual([
			["https://chatgpt.com/codex/settings/usage"],
			["https://claude.ai/settings/usage"],
		]);
		expect(creditSpend.set).not.toHaveBeenCalled();
		expect(shown()).toBe("off");
		// The one line and its links are the whole of it: no top-up control stands in the row.
		expect(document.body.querySelectorAll("[data-credit-spend] input, [data-credit-spend] select")).toHaveLength(0);
		expect(document.body.querySelectorAll('[data-credit-spend] [role="switch"]')).toHaveLength(1);
	});

	it("reads and writes a paired host's own switch", async () => {
		state = { enabled: true };
		await mount("host-b");
		expect(creditSpend.get).toHaveBeenCalledWith("host-b");
		expect(shown()).toBe("on");
		await act(async () => {
			toggle().click();
		});
		await settle();
		expect(creditSpend.set).toHaveBeenCalledWith(false, "host-b");
		expect(shown()).toBe("off");
	});

	it("puts the old state back and toasts when a save fails", async () => {
		failSet = true;
		await mount();
		await act(async () => {
			toggle().click();
		});
		await settle();
		expect(shown()).toBe("off");
		expect(useToastStore.getState().toasts.map(entry => entry.title)).toEqual([translate("settings.saveFailed")]);
	});

	it("shows no row when the machine can't answer", async () => {
		creditSpend.get.mockRejectedValueOnce(new Error("too old"));
		await mount("host-b");
		expect(document.body.querySelector("[data-credit-spend]")).toBeNull();
	});
});
