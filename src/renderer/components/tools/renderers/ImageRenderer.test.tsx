import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";

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

const { createRoot } = await import("react-dom/client");
const { ImageRenderer } = await import("./ImageRenderer");

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

/** A `generate_image` result as stock builds it (tools/image-gen.ts `buildToolResult`). */
function generated(image: Record<string, unknown>) {
	return {
		content: [{ type: "text", text: "Provider: openai-codex\nGenerated 1 image(s)" }],
		details: {
			provider: "openai-codex",
			model: "gpt-image-2-codex",
			imageCount: 1,
			imagePaths: ["/tmp/omp-image-1.png"],
			images: [{ data: "iVBORw0KGgo=", mimeType: "image/png", ...image }],
		},
	};
}

describe("ImageRenderer", () => {
	it("names under the picture what made it and the size and quality the backend reported", async () => {
		await mount(
			<ImageRenderer args={{ subject: "a cat" }} result={generated({ size: "1024x1024", quality: "medium" })} />,
		);
		expect(container.textContent).toContain("openai-codex · gpt-image-2-codex · 1024x1024 · quality medium");
	});

	it("leaves out what the backend did not report", async () => {
		await mount(<ImageRenderer args={{ subject: "a cat" }} result={generated({})} />);
		expect(container.textContent).toContain("openai-codex · gpt-image-2-codex");
		expect(container.textContent).not.toContain("quality");
	});
});
