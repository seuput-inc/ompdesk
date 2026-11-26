/**
 * A saved draft's picture in the strip: a still placeholder while it is read back (never a warning before the read
 * ends), a warning chip that opens the chooser once it is gone, and the same name attached again takes its place.
 */
import { parseHTML } from "linkedom";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../../lib/i18n";
import { type DraftPictureRef, useComposerStore } from "../../../stores/composer";
import { ComposerAttachments } from "./ComposerAttachments";

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

const shot: DraftPictureRef = { id: "a", name: "shot.png", mimeType: "image/png" };
const picture = (data: string, name?: string) => ({
	content: { type: "image" as const, data, mimeType: "image/png" },
	preview: `data:image/png;base64,${data}`,
	name,
});

let container: HTMLElement;
let root: Root;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useComposerStore.getState().reset();
});

function Strip({ onAttachAgain }: { onAttachAgain: () => void }) {
	const slots = useComposerStore(s => s.pictureSlots);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	return (
		<ComposerAttachments
			onAttachAgain={onAttachAgain}
			pictureSlots={slots}
			placeDraft={() => {}}
			sendingFiles={[]}
			setText={() => {}}
			text=""
			textareaRef={textareaRef}
			touch={false}
		/>
	);
}

async function mount(onAttachAgain: () => void): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<Strip onAttachAgain={onAttachAgain} />
			</I18nProvider>,
		);
	});
}

const items = () => Array.from(container.querySelectorAll("[data-strip-item]"));
const missingChip = () => container.querySelector('[data-draft-picture="missing"]');

describe("ComposerAttachments draft pictures", () => {
	it("waits quietly for a saved picture, asks for it again once gone, and takes it back in place", async () => {
		const attachAgain = vi.fn();
		useComposerStore.getState().restorePictureRefs([shot]);
		useComposerStore.getState().setImages(current => [...current, picture("AA==")]);
		await mount(attachAgain);
		expect(items()[0]?.getAttribute("data-draft-picture")).toBe("pending");
		expect(missingChip()).toBeNull();
		expect(container.textContent).not.toContain(translate("input.draft.attachAgain", { name: "shot.png" }));

		await act(async () => useComposerStore.getState().resolvePictureRef(shot, null));
		expect(missingChip()?.textContent).toContain(translate("input.draft.attachAgain", { name: "shot.png" }));
		await act(async () => {
			missingChip()
				?.querySelector("button")
				?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(attachAgain).toHaveBeenCalledTimes(1);

		await act(async () => void useComposerStore.getState().attachImages([picture("AQ==", "shot.png")]));
		expect(missingChip()).toBeNull();
		expect(items().map(item => item.querySelector("img")?.getAttribute("src"))).toEqual([
			"data:image/png;base64,AQ==",
			"data:image/png;base64,AA==",
		]);
	});
});
