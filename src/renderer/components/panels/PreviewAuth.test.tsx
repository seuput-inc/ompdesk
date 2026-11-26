import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewAuthPrompt } from "../../../shared/preview";
import { I18nProvider } from "../../lib/i18n";
import { PreviewAuthDialog } from "./PreviewAuth";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let root: Root | undefined;

async function mount(auth: PreviewAuthPrompt | null, onAnswer = vi.fn()) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const created = createRoot(container as unknown as globalThis.Element);
	root = created;
	const render = (next: PreviewAuthPrompt | null) =>
		act(async () =>
			created.render(
				<I18nProvider>
					<PreviewAuthDialog auth={next} onAnswer={onAnswer} />
				</I18nProvider>,
			),
		);
	await render(auth);
	return { onAnswer, render };
}

/** Types into the name (`0`) or the password (`1`) field. */
const type = async (index: 0 | 1, value: string) => {
	const field = [...document.querySelectorAll("[data-preview-auth] input")][index] as unknown as
		| Record<string, unknown>
		| undefined;
	if (!field) throw new Error(`No field ${index}`);
	field.value = value;
	// linkedom fires no change React's value tracker sees: call the field's own change handler, as typing would.
	const propsKey = Object.getOwnPropertyNames(field).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (field[propsKey] as { onChange?: (event: object) => void }) : undefined;
	await act(async () => props?.onChange?.({ target: field, currentTarget: field }));
};

const button = (text: string) =>
	[...document.querySelectorAll("button")].find(candidate => candidate.textContent === text) as unknown as
		| { click: () => void }
		| undefined;

afterEach(async () => {
	const mounted = root;
	root = undefined;
	if (mounted) await act(async () => mounted.unmount());
	document.body.innerHTML = "";
});

describe("a server's sign-in in the Preview", () => {
	it("names the asking server, and gives what was typed to that one prompt", async () => {
		const { onAnswer } = await mount({ id: 7, origin: "https://intranet.example", realm: "Staff" });
		expect(document.body.textContent).toContain("https://intranet.example");
		expect(document.body.textContent).toContain("Staff");
		await type(0, "ada");
		await type(1, "s3cret");
		// Sign in (the form's own submit button, `form="preview-auth"`) or Enter submits the form; linkedom has no
		// implicit submission, so the form is submitted directly.
		await act(async () => {
			document
				.querySelector("[data-preview-auth]")
				?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(onAnswer).toHaveBeenCalledWith(7, { username: "ada", password: "s3cret" });
	});

	it("cancels with nothing, and a new prompt starts empty", async () => {
		const { onAnswer, render } = await mount({ id: 1, origin: "http://localhost:8080", realm: "" });
		await type(1, "typed");
		await act(async () => button("Cancel")?.click());
		expect(onAnswer).toHaveBeenCalledWith(1, null);
		await render({ id: 2, origin: "http://localhost:8080", realm: "" });
		const values = [...document.querySelectorAll("input")].map(
			input => (input as unknown as { value: string }).value,
		);
		expect(values).toEqual(["", ""]);
	});
});
