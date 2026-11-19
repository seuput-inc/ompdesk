/**
 * Settings › Tools & extensions › project boundary: the stored mode (off while nothing is stored), a pick written
 * through the row's own channel and never the generic prefs write, and a paired page that shows the value without
 * being able to change it.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ProjectBoundaryRow } from "./ProjectBoundaryRow";

const page = vi.hoisted(() => ({ web: false }));
vi.mock("../../web/runtime", () => ({ webRuntime: () => (page.web ? {} : null) }));

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

let stored: unknown;
const prefs = {
	get: vi.fn(async (_key?: string): Promise<unknown> => stored),
	set: vi.fn(async (): Promise<void> => undefined),
	setProjectBoundary: vi.fn(async (_mode: string): Promise<void> => undefined),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });

const roots: Root[] = [];

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ProjectBoundaryRow />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function field(): HTMLSelectElement {
	const select = document.body.querySelector("#setting-gui-projectBoundary select") as HTMLSelectElement | null;
	if (!select) throw new Error("project boundary select missing");
	return select;
}

async function choose(value: string): Promise<void> {
	const record = field() as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	// React keeps a host element's props under this key; linkedom dispatches no change event React hears.
	const props: { onChange?: (event: object) => void } = key ? (record[key] as object) : {};
	const { onChange } = props;
	if (!onChange) throw new Error("select onChange not found");
	await act(async () => onChange({ target: { value }, currentTarget: { value } }));
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	stored = undefined;
	page.web = false;
	vi.clearAllMocks();
});

describe("ProjectBoundaryRow", () => {
	it("offers Off, Log only and Enforce, and shows Off while nothing is stored", async () => {
		await mount();
		expect(Array.from(field().querySelectorAll("option")).map(option => option.textContent)).toEqual([
			"Off",
			"Log only",
			"Enforce",
		]);
		expect(field().value).toBe("off");
		expect(field().disabled).toBe(false);
	});

	it("shows the stored mode", async () => {
		stored = { mode: "enforce", earlierOpened: "grant" };
		await mount();
		expect(field().value).toBe("enforce");
	});

	it("writes a pick through its own channel, never the generic prefs write, and refuses a value outside the list", async () => {
		await mount();
		await choose("log");
		expect(prefs.setProjectBoundary.mock.calls).toEqual([["log"]]);
		expect(field().value).toBe("log");
		await choose("strict");
		expect(prefs.setProjectBoundary).toHaveBeenCalledTimes(1);
		expect(prefs.set).not.toHaveBeenCalled();
	});

	it("shows the value on a paired page and does not let it change there", async () => {
		page.web = true;
		stored = { mode: "enforce" };
		await mount();
		expect(field().value).toBe("enforce");
		expect(field().disabled).toBe(true);
		expect(document.body.textContent).toContain("Change this on the computer itself");
	});
});
