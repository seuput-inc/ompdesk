import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatCardActions, ChatCardFrame, ChatCardStatus } from "./ChatCardFrame";

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

let container: HTMLElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("ChatCardFrame", () => {
	it("renders framed header, eyebrow, status pill, body, and footer actions", async () => {
		await act(async () => {
			root.render(
				<ChatCardFrame
					data-card-kind="bot-offer"
					eyebrow="New bot suggestion"
					footer={
						<ChatCardActions aside={<span>1–2 pick</span>}>
							<span>Create bot</span>
						</ChatCardActions>
					}
					status={<ChatCardStatus label="Ready" meta="2s" tone="success" />}
					title="Design QA Bot"
				>
					<p>Checks theme contrast automatically.</p>
				</ChatCardFrame>,
			);
		});

		const frame = container.querySelector("[data-chat-card-frame]");
		expect(frame?.getAttribute("data-card-kind")).toBe("bot-offer");
		expect(frame?.textContent).toContain("New bot suggestion");
		expect(frame?.textContent).toContain("Design QA Bot");
		expect(frame?.textContent).toContain("Checks theme contrast automatically.");
		expect(frame?.textContent).toContain("Create bot");
		expect(frame?.textContent).toContain("1–2 pick");

		const status = container.querySelector('[data-chat-card-status="success"]');
		expect(status?.textContent).toContain("Ready");
		expect(status?.textContent).toContain("2s");
	});

	it("omits empty body and footer regions cleanly", async () => {
		await act(async () => {
			root.render(<ChatCardFrame title="Compact Card" />);
		});

		const frame = container.querySelector("[data-chat-card-frame]");
		expect(frame?.children).toHaveLength(1);
		expect(container.querySelector("[data-chat-card-actions]")).toBeNull();
	});
});
