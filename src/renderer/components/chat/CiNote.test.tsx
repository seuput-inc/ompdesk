import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CI_MESSAGE_TYPE } from "../../../../resources/gui-bridge/modes/ci-watch-contracts";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { CiNote } from "./CiNote";

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

async function show(details: unknown): Promise<HTMLElement> {
	const message: AgentMessage = {
		role: "custom",
		customType: CI_MESSAGE_TYPE,
		content: "",
		display: true,
		details,
		timestamp: 1,
	};
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<CiNote message={message} />
			</I18nProvider>,
		);
	});
	return container;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

const BASE = {
	id: "ci-1",
	host: "github.com",
	repo: "owner/repo",
	branch: "main",
	sha: "abc1234def5678abc1234def5678abc1234def56",
};

describe("CI result note", () => {
	it("says CI passed for the pushed commit", async () => {
		const view = await show({ ...BASE, outcome: "success", failed: [] });

		expect(view.textContent).toBe("CI passed · owner/repo@abc1234 (main)");
		expect(view.querySelector("[data-ci-note]")?.getAttribute("data-ci-note")).toBe("success");
	});

	it("names the failed jobs and offers the run", async () => {
		const view = await show({
			...BASE,
			outcome: "failure",
			failed: ["check", "native"],
			url: "https://github.com/owner/repo/actions/runs/7",
		});

		expect(view.textContent).toBe("CI failed · owner/repo@abc1234 (main) · check, native · Open run");
		expect(view.querySelector("[data-ci-note]")?.getAttribute("data-ci-note")).toBe("failure");
		expect(view.querySelector("button")?.textContent).toBe("Open run");
	});

	it("shows nothing for details that are no CI result", async () => {
		expect((await show({ ...BASE, outcome: "pending" })).textContent).toBe("");
		expect((await show({ id: "ci-1" })).textContent).toBe("");
	});
});
