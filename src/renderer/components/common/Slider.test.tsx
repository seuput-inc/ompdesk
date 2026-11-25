/**
 * Slider is the native range input (role slider; its min, max and value are what a screen reader reads as
 * aria-valuemin/max/now), named by its visible label, with the value written beside the label.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { Slider } from "./Slider";

async function mounted(node: ReactNode, check: (document: Document) => void | Promise<void>): Promise<void> {
	const { document, window } = parseHTML("<html><body></body></html>");
	Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
	const root = createRoot(document.body as unknown as globalThis.Element);
	try {
		await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
		await check(document as unknown as Document);
	} finally {
		await act(async () => root.unmount());
	}
}

/** What the browser does when an arrow key or a drag moves the thumb: a new value and an input event. */
async function move(input: HTMLInputElement, value: string): Promise<void> {
	await act(async () => {
		// React-DOM took its old-IE input polyfill (linkedom globals land after it loads): it hooks the focused field's
		// `attachEvent` and diffs its value on keyup through the prototype setter's tracker, so set it there.
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

const slider = (document: Document) => document.querySelector('input[type="range"]') as HTMLInputElement;

describe("Slider", () => {
	it("is a range named by its label, with its min, max and value", async () => {
		await mounted(<Slider label="Volume" max={100} onChange={() => {}} step={5} value={40} />, document => {
			const input = slider(document);
			expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("Volume");
			expect([input.getAttribute("min"), input.getAttribute("max"), input.getAttribute("step")]).toEqual([
				"0",
				"100",
				"5",
			]);
			expect(input.value).toBe("40");
			expect(document.querySelector("[data-slider] span[aria-hidden]")?.textContent).toBe("40");
		});
	});

	it("writes a large value in the app's language beside the label", async () => {
		await mounted(<Slider label="Tokens" max={5000} onChange={() => {}} value={1234} />, document => {
			expect(document.querySelector("[data-slider] span[aria-hidden]")?.textContent).toBe("1,234");
		});
	});

	it("reports a moved thumb as a number", async () => {
		const change = vi.fn();
		await mounted(<Slider label="Volume" max={10} onChange={change} value={5} />, async document => {
			await move(slider(document), "6");
			expect(change).toHaveBeenCalledWith(6);
		});
	});

	it("is a disabled input when disabled, so the browser takes no keys or drags", async () => {
		await mounted(<Slider disabled label="Volume" max={10} onChange={() => {}} value={5} />, document => {
			expect(slider(document).disabled).toBe(true);
		});
	});
});
