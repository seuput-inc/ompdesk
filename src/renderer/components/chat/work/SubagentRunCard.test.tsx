import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubagentRunCard } from "./SubagentRunCard";

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

describe("SubagentRunCard", () => {
	it("renders role badge, live pulsing dot, elapsed time, and collapsible peek", async () => {
		await act(async () => {
			root.render(
				<SubagentRunCard
					defaultOpen={false}
					elapsed="4.8s"
					metrics={<span>8 tools · $0.14</span>}
					name="Explore-UI"
					role="explore"
					state="running"
					summary="Inspecting PromptCard and BotCards"
				>
					<pre>Detailed subagent transcript output</pre>
				</SubagentRunCard>,
			);
		});

		const card = container.querySelector("[data-subagent-run-card]");
		expect(card?.getAttribute("data-status")).toBe("running");
		expect(card?.querySelector('[data-subagent-dot="running"]')?.className).toContain("omp-pulse-dot");
		expect(card?.querySelector('[data-subagent-role="explore"]')?.textContent).toBe("explore");
		expect(card?.querySelector("[data-subagent-elapsed]")?.textContent).toBe("4.8s");
		expect(card?.querySelector("[data-subagent-summary]")?.textContent).toBe("Inspecting PromptCard and BotCards");
		expect(card?.textContent).not.toContain("Detailed subagent transcript output");

		const toggle = card?.querySelector<HTMLButtonElement>("[data-subagent-toggle]");
		await act(async () => {
			toggle?.click();
		});
		expect(card?.textContent).toContain("Detailed subagent transcript output");
	});

	it("omits the generic task role badge and toggle when no body is provided", async () => {
		await act(async () => {
			root.render(<SubagentRunCard name="Worker-1" role="task" state="done" />);
		});

		expect(container.querySelector("[data-subagent-role]")).toBeNull();
		expect(container.querySelector("[data-subagent-toggle]")).toBeNull();
		expect(container.querySelector('[data-subagent-dot="done"]')).not.toBeNull();
	});
});
