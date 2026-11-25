/**
 * A saved draft's pictures come back as ordered places in the strip: unread ones never count as sendable, a read
 * lands only in the place still waiting for it, and a picture attached again by name fills one gone place in place.
 */
import { describe, expect, it } from "vitest";
import { type ComposerImage, createComposerStore, type DraftPictureRef } from "./composer";

const ref = (id: string, name = `${id}.png`): DraftPictureRef => ({ id, name, mimeType: "image/png" });
const picture = (data: string, name?: string): ComposerImage => ({
	content: { type: "image", data, mimeType: "image/png" },
	preview: `data:image/png;base64,${data}`,
	...(name ? { name } : {}),
});

describe("composer picture slots", () => {
	it("restores refs as unread places at once and fills each in place when its read lands", () => {
		const store = createComposerStore();
		const [a, b] = [ref("a"), ref("b")];
		store.getState().restorePictureRefs([a, b]);
		store.getState().restorePictureRefs([a]);
		expect(store.getState().pictureSlots).toEqual([
			{ ref: a, status: "pending" },
			{ ref: b, status: "pending" },
		]);
		expect(store.getState().images).toEqual([]);

		store.getState().resolvePictureRef(b, picture("Qg=="));
		store.getState().resolvePictureRef(a, null);
		const [first, second] = store.getState().pictureSlots;
		expect(first).toEqual({ ref: a, status: "missing" });
		expect(second).toMatchObject({ content: { data: "Qg==" }, name: "b.png", draftRef: b });
		expect(store.getState().images).toEqual([second]);
	});

	it("drops a read whose place is gone, and never turns a gone place back", () => {
		const store = createComposerStore();
		const a = ref("a");
		store.getState().restorePictureRefs([a]);
		store.getState().setPictureSlots([]);
		store.getState().resolvePictureRef(a, picture("QQ=="));
		expect(store.getState().pictureSlots).toEqual([]);

		store.getState().restorePictureRefs([a]);
		store.getState().resolvePictureRef(a, null);
		store.getState().resolvePictureRef(a, picture("QQ=="));
		expect(store.getState().pictureSlots).toEqual([{ ref: a, status: "missing" }]);
	});

	it("fills only the first unread place of the same name, in place; bytes already attached are a duplicate", () => {
		const store = createComposerStore();
		const [x, y] = [ref("x", "shot.png"), ref("y", "shot.png")];
		store.getState().setImages([picture("AA==")]);
		store.getState().restorePictureRefs([x, y]);
		store.getState().resolvePictureRef(x, null);

		expect(store.getState().attachImages([picture("AQ==", "shot.png"), picture("AA==", "other.png")])).toBe(1);
		expect(store.getState().pictureSlots).toEqual([
			picture("AA=="),
			picture("AQ==", "shot.png"),
			{ ref: y, status: "pending" },
		]);
		expect(store.getState().attachImages([picture("Ag==", "new.png")])).toBe(0);
		expect(store.getState().pictureSlots.at(-1)).toEqual(picture("Ag==", "new.png"));
	});

	it("keeps unread places where they are when the ready pictures change, and a list replaces them all", () => {
		const store = createComposerStore();
		const a = ref("a");
		const kept = picture("AA==");
		store.getState().setImages([kept]);
		store.getState().restorePictureRefs([a]);
		store.getState().setImages(current => [...current, picture("AQ==")]);
		expect(store.getState().pictureSlots).toEqual([kept, { ref: a, status: "pending" }, picture("AQ==")]);
		store.getState().setImages(current => current.filter(image => image !== kept));
		expect(store.getState().pictureSlots).toEqual([{ ref: a, status: "pending" }, picture("AQ==")]);
		store.getState().setImages([]);
		expect(store.getState().pictureSlots).toEqual([]);
	});

	it("parks unread places with a queued edit's snapshot, lands their read there, and gives them back", () => {
		const store = createComposerStore();
		const a = ref("a");
		store.getState().setDraft("draft");
		store.getState().restorePictureRefs([a]);
		store
			.getState()
			.beginEditQueued({ id: "q", lane: "steering", text: "queued", token: "t", began: Promise.resolve(true) });
		expect(store.getState().pictureSlots).toEqual([]);
		store.getState().resolvePictureRef(a, picture("QQ=="));
		expect(store.getState().images).toEqual([]);
		store.getState().endEditQueued();
		expect(store.getState().draft).toBe("draft");
		expect(store.getState().images).toEqual([{ ...picture("QQ=="), name: "a.png", draftRef: a }]);
	});
});
