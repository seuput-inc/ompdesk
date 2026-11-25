import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewNotesStore } from "./review-notes";

// The store reaches `localStorage` on each write, so a stub set after the import is the one it writes to.
const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => saved.get(key) ?? null,
	setItem: (key: string, value: string) => saved.set(key, value),
	removeItem: (key: string) => saved.delete(key),
});

beforeEach(() => {
	saved.clear();
	useReviewNotesStore.getState().reset();
});

describe("review notes store", () => {
	it("keeps a region's screenshot in memory, never in the localStorage drafts and the outbox share", () => {
		const note = useReviewNotesStore.getState().add({
			owner: "|s:1",
			anchor: {
				kind: "preview",
				page: "http://x/",
				title: "X",
				url: "http://x/",
				pick: "region",
				elements: [],
				image: "PNG",
			},
			body: "",
		});
		expect(note.anchor).toMatchObject({ n: 1, image: "PNG" });
		expect(saved.get("omp.review-notes.v1")).not.toContain("PNG");
		// A write from this window (another note's edit) and a reload keep the picture it holds.
		useReviewNotesStore.getState().update(note.id, { body: "tighter" });
		useReviewNotesStore.getState().reload();
		expect(useReviewNotesStore.getState().notes[0]?.anchor).toMatchObject({ image: "PNG" });
		expect(useReviewNotesStore.getState().notes[0]?.body).toBe("tighter");
	});

	it("numbers a page's pins on from the highest one left", () => {
		const add = (page: string) =>
			useReviewNotesStore.getState().add({
				owner: "|s:1",
				anchor: { kind: "preview", page, title: "", url: page, pick: "element", elements: [] },
				body: "",
			});
		const first = add("http://a/");
		add("http://a/");
		useReviewNotesStore.getState().remove([first.id]);
		expect(add("http://a/").anchor).toMatchObject({ n: 3 });
		expect(add("http://b/").anchor).toMatchObject({ n: 1 });
	});
});
