/**
 * The A2UI views on the kit: names and roles, two-way binding into the surface's data model, checks gating a Button,
 * an inert card that takes nothing, and a type the catalog does not draw (docs/design/a2ui.md §2, §4).
 */

import { getValue, NodeResolver } from "@a2ui/web_core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import catalogDocument from "../../../../../resources/gui-bridge/modes/a2ui-catalog.json";
import { I18nProvider } from "../../i18n";
import { A2uiSession } from "../session";
import { chartSeries } from "./Chart";
import { SurfaceView } from "./SurfaceView";

const v = (body: Record<string, unknown>) => ({ version: "1.0", ...body });

function sessionOf(components: Record<string, unknown>[], data: Record<string, unknown> = {}): A2uiSession {
	const session = new A2uiSession("en-US");
	session.sync([
		{
			id: "c",
			key: "c",
			streaming: false,
			refused: false,
			messages: [
				v({ createSurface: { surfaceId: "s", catalogId: catalogDocument.catalogId } }),
				v({ updateComponents: { surfaceId: "s", components } }),
				v({ updateDataModel: { surfaceId: "s", value: data } }),
			],
		},
	]);
	return session;
}

async function mounted(
	session: A2uiSession,
	inert: boolean,
	check: (document: Document) => void | Promise<void>,
): Promise<void> {
	const { document, window } = parseHTML("<html><body></body></html>");
	// chart.js reads the theme's tokens; linkedom computes no style, so the chart falls back to the scheme's own.
	const getComputedStyle = () => ({ getPropertyValue: () => "", fontSize: "15px" });
	Object.assign(globalThis, { document, window, getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
	const surface = session.surface("s");
	if (!surface) throw new Error("no surface");
	const root = createRoot(document.body as unknown as Element);
	try {
		await act(async () =>
			root.render(
				<I18nProvider>
					<SurfaceView inert={inert} surface={surface} />
				</I18nProvider>,
			),
		);
		await check(document as unknown as Document);
	} finally {
		await act(async () => root.unmount());
	}
}

/** What typing does to a field: its value set through the prototype setter (React's tracker) and an input event. */
async function type(input: Element | null, value: string): Promise<void> {
	if (!input) throw new Error("no field");
	await act(async () => {
		Object.assign(input, { attachEvent() {}, detachEvent() {} });
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		let proto: object | null = Object.getPrototypeOf(input);
		let setter: ((next: string) => void) | undefined;
		while (proto && !setter) {
			setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			proto = Object.getPrototypeOf(proto);
		}
		setter?.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
	});
}

async function click(element: Element | null, checked?: boolean): Promise<void> {
	if (!element) throw new Error("nothing to click");
	await act(async () => {
		if (checked !== undefined) Object.assign(element, { checked });
		element.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}

/** The kit's Button keeps a disabled one focusable for its reason (`aria-disabled`); a field is plainly disabled. */
const off = (element: Element | undefined) =>
	(element as HTMLInputElement | undefined)?.disabled === true || element?.getAttribute("aria-disabled") === "true";
const labelled = (document: Document, text: string) => {
	const label = [...document.querySelectorAll("label")].find(l => l.textContent === text);
	const id = label?.getAttribute("for");
	return id ? document.getElementById(id) : null;
};

const FORM = [
	{ id: "root", component: "Column", children: ["email", "agree", "size", "volume", "send"] },
	{
		id: "email",
		component: "TextField",
		label: "Email",
		value: { "@path": "/email" },
		checks: [{ condition: { "@call": "email", args: { value: { "@path": "/email" } } }, message: "Enter an email" }],
	},
	{ id: "agree", component: "CheckBox", label: "I agree", value: { "@path": "/agree" } },
	{
		id: "size",
		component: "ChoicePicker",
		label: "Size",
		variant: "mutuallyExclusive",
		options: [
			{ label: "Small", value: "s" },
			{ label: "Large", value: "l" },
		],
		value: { "@path": "/size" },
	},
	{ id: "volume", component: "Slider", label: "Volume", min: 0, max: 10, value: { "@path": "/volume" } },
	{
		id: "send",
		component: "Button",
		variant: "primary",
		child: "send_label",
		action: { event: { name: "send", context: { email: { "@path": "/email" } } } },
		checks: [{ condition: { "@call": "email", args: { value: { "@path": "/email" } } }, message: "Enter an email" }],
	},
	{ id: "send_label", component: "Text", text: "Send" },
];

describe("A2UI views", () => {
	it("binds each input to the data model and gates the Button on its checks", async () => {
		const session = sessionOf(FORM, { email: "", size: [], volume: 2 });
		const actions: unknown[] = [];
		session.onAction(action => void actions.push(action));
		const model = () => session.surface("s")?.dataModel.get("/");
		await mounted(session, false, async document => {
			const send = () => [...document.querySelectorAll("button")].find(b => b.textContent === "Send");
			expect(off(send())).toBe(true);
			await type(labelled(document, "Email"), "ann@example.com");
			await click(labelled(document, "I agree") ?? document.querySelector('input[type="checkbox"]'), true);
			const radios = document.querySelectorAll('[role="radiogroup"] input[type="radio"]');
			await click(radios[1] ?? null, true);
			await type(labelled(document, "Volume"), "7");
			expect(model()).toEqual({ email: "ann@example.com", agree: true, size: ["l"], volume: 7 });
			// The disabled Button was a Tooltip's anchor; enabled, it is a plain button again.
			expect(off(send())).toBe(false);
			await click(send() ?? null);
			expect(actions).toMatchObject([
				{ name: "send", sourceComponentId: "send", context: { email: "ann@example.com" } },
			]);
		});
	});

	it("names the radio group by its label", async () => {
		await mounted(sessionOf(FORM), false, document => {
			const group = document.querySelector('[role="radiogroup"]');
			const name = document.getElementById(group?.getAttribute("aria-labelledby") ?? "");
			expect(name?.textContent).toBe("Size");
		});
	});

	it("takes nothing while inert: every input and the Button are disabled", async () => {
		await mounted(sessionOf(FORM, { email: "ann@example.com" }), true, document => {
			const controls = [...document.querySelectorAll("input, button")];
			expect(controls.length).toBeGreaterThan(4);
			for (const control of controls) expect(off(control), control.outerHTML).toBe(true);
		});
	});

	it("draws tabs, a list and a described chart with the kit's roles", async () => {
		const session = sessionOf(
			[
				{ id: "root", component: "Column", children: ["tabs", "list", "chart", "odd"] },
				{
					id: "tabs",
					component: "Tabs",
					tabs: [
						{ title: "Week", child: "week" },
						{ title: "Month", child: "month" },
					],
				},
				{ id: "week", component: "Text", text: "Seven days" },
				{ id: "month", component: "Text", text: "Thirty days" },
				{ id: "list", component: "List", children: { path: "/rows", componentId: "row" } },
				{ id: "row", component: "Text", text: { "@path": "name" } },
				{
					id: "chart",
					component: "Chart",
					kind: "bar",
					labels: ["Mon", "Tue"],
					series: [{ label: "Runs", values: { "@path": "/runs" } }],
					description: "Runs on Monday and Tuesday",
				},
				{ id: "odd", component: "Marquee", text: "?" },
			],
			{ rows: [{ name: "one" }, { name: "two" }], runs: [3, 4] },
		);
		await mounted(session, false, async document => {
			const tabs = [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent);
			expect(tabs).toEqual(["Week", "Month"]);
			expect(document.body.textContent).toContain("Seven days");
			expect(document.querySelectorAll('[role="list"] > [role="listitem"]')).toHaveLength(2);
			const chart = document.querySelector('[data-a2ui-chart="bar"] [role="img"]');
			expect(chart?.getAttribute("aria-label")).toBe("Runs on Monday and Tuesday");
			expect(document.querySelector("[data-a2ui-unsupported]")?.textContent).toContain("Marquee");
			expect(document.querySelector("marquee")).toBeNull();
		});
	});
});

describe("Chart series", () => {
	it("reads a bound series from the data model and follows it", () => {
		const session = sessionOf(
			[
				{
					id: "root",
					component: "Chart",
					kind: "bar",
					labels: ["Mon", "Tue"],
					series: [
						{ label: "Runs", values: { "@path": "/runs" } },
						{ label: "Goal", values: [4, 4] },
					],
					description: "Runs against the goal",
				},
			],
			{ runs: [3, 5] },
		);
		const surface = session.surface("s");
		const node = surface && getValue(new NodeResolver(surface).rootNode);
		if (!surface || !node) throw new Error("no chart");
		const shown = () => chartSeries(getValue(node.props).series);
		expect(shown()).toEqual([
			{ label: "Runs", values: [3, 5] },
			{ label: "Goal", values: [4, 4] },
		]);
		surface.dataModel.set("/runs", [6, 7]);
		expect(shown()[0]).toEqual({ label: "Runs", values: [6, 7] });
	});
});
