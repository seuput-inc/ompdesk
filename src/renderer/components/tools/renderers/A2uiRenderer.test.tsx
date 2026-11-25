/**
 * The A2UI card's answer path (docs/design/a2ui.md §2 › Actions back to the agent): the chat row answers the call's
 * pending marker form with the pressed action, a folded copy never does, and the transcript's answer is what shows
 * afterwards.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	A2UI_ANSWER_FIELD,
	A2UI_CATALOG_ID,
	a2uiMarkerForm,
} from "../../../../../resources/gui-bridge/modes/a2ui-contracts";
import type { AgentMessage, ExtensionUIResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useMessagesStore } from "../../../stores/messages";
import { useToolsStore } from "../../../stores/tools";
import { A2uiCard } from "./A2uiRenderer";

const { document, window } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

const v = (body: Record<string, unknown>) => ({ version: "1.0", ...body });
const MESSAGES = [
	v({ createSurface: { surfaceId: "contact", catalogId: A2UI_CATALOG_ID, sendDataModel: true } }),
	v({
		updateComponents: {
			surfaceId: "contact",
			components: [
				{ id: "root", component: "Column", children: ["name", "send"] },
				{
					id: "name",
					component: "TextField",
					label: "Name",
					value: { "@path": "/name" },
					checks: [
						{ condition: { "@call": "required", args: { value: { "@path": "/name" } } }, message: "Need it" },
					],
				},
				{
					id: "send",
					component: "Button",
					variant: "primary",
					child: "send_label",
					action: { event: { name: "submit", context: { name: { "@path": "/name" } } } },
					checks: [
						{ condition: { "@call": "required", args: { value: { "@path": "/name" } } }, message: "Need it" },
					],
				},
				{ id: "send_label", component: "Text", text: "Send" },
			],
		},
	}),
	v({ updateDataModel: { surfaceId: "contact", value: { name: "" } } }),
];

const call: AgentMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call_1", name: "a2ui", arguments: { messages: MESSAGES } }],
	timestamp: 1,
};

let root: Root | undefined;
let respond: Mock<(response: ExtensionUIResponse, tabId?: string) => Promise<void>>;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	useMessagesStore.getState().reset();
	useToolsStore.getState().reset();
	useExtensionUiStore.getState().clearAll();
});

async function show(transcript: AgentMessage[], { live, pending }: { live: boolean; pending: boolean }) {
	respond = vi.fn(async () => {});
	Object.assign(window, { omp: { ui: { respondExtensionUi: respond } } });
	await act(async () => {
		useMessagesStore.setState({ messages: transcript });
		useToolsStore.getState().hydrateMessages(transcript);
		if (pending) {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				method: "form",
				id: "form-1",
				html: a2uiMarkerForm("call_1"),
			});
		}
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<A2uiCard live={live} toolCallId="call_1" />
			</I18nProvider>,
		),
	);
	return container;
}

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

async function click(element: Element | null | undefined): Promise<void> {
	if (!element) throw new Error("nothing to click");
	await act(async () => {
		element.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}

const send = (container: Element) => [...container.querySelectorAll("button")].find(b => b.textContent === "Send");
const off = (element: Element | undefined) =>
	(element as HTMLInputElement | undefined)?.disabled === true || element?.getAttribute("aria-disabled") === "true";

describe("A2uiCard answers", () => {
	it("answers the call's pending form with the pressed action and the surface's data model", async () => {
		const card = await show([call], { live: true, pending: true });
		expect(card.querySelector("[data-a2ui-live]")).not.toBeNull();
		expect(off(send(card))).toBe(true);
		await type(card.querySelector("input"), "Ann");
		expect(off(send(card))).toBe(false);
		await click(send(card));
		expect(respond).toHaveBeenCalledTimes(1);
		const [response] = respond.mock.calls[0] ?? [];
		if (!response || !("data" in response)) throw new Error("no data answer");
		expect(response.id).toBe("form-1");
		expect(JSON.parse(String(response.data[A2UI_ANSWER_FIELD]))).toMatchObject({
			name: "submit",
			surfaceId: "contact",
			sourceComponentId: "send",
			context: { name: "Ann" },
			dataModel: { name: "Ann" },
		});
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});

	it("is inert without a pending form, and a folded copy never answers one", async () => {
		const waiting = await show([call], { live: false, pending: true });
		expect(waiting.querySelector("[data-a2ui-live]")).toBeNull();
		expect(off(waiting.querySelector("input") ?? undefined)).toBe(true);
		expect(off(send(waiting))).toBe(true);
		await act(async () => {
			root?.unmount();
			useExtensionUiStore.getState().clearAll();
		});
		const answered = await show([call], { live: true, pending: false });
		expect(answered.querySelector("[data-a2ui-skip]")).toBeNull();
		expect(off(answered.querySelector("input") ?? undefined)).toBe(true);
	});

	it("skips: cancels the call's form", async () => {
		const card = await show([call], { live: true, pending: true });
		await click(card.querySelector("[data-a2ui-skip]"));
		expect(respond).toHaveBeenCalledWith({ type: "extension_ui_response", id: "form-1", cancelled: true });
	});

	it("shows what the person sent once the transcript has the answer, with the submitted values", async () => {
		const action = {
			name: "submit",
			surfaceId: "contact",
			sourceComponentId: "send",
			context: { name: "Ann" },
			dataModel: { name: "Ann" },
		};
		const result: AgentMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "a2ui",
			isError: false,
			details: { action },
			content: [{ type: "text", text: 'Pressed "submit"' }],
			timestamp: 2,
		};
		const card = await show([call, result], { live: true, pending: false });
		expect(card.querySelector("[data-a2ui-sent]")?.textContent).toBe(translate("a2ui.sent", { action: "submit" }));
		expect(send(card)?.hasAttribute("data-a2ui-pressed")).toBe(true);
		expect((card.querySelector("input") as HTMLInputElement | null)?.value).toBe("Ann");
	});
});
