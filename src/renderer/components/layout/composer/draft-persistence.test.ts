import { describe, expect, it, vi } from "vitest";
import type { ComposerImage } from "../../../stores/composer";
import { draftKeys, loadDraft, saveDraft } from "./draft-persistence";

function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: key => items.get(key) ?? null,
		key: index => [...items.keys()][index] ?? null,
		removeItem: key => {
			items.delete(key);
		},
		setItem: (key, value) => {
			items.set(key, value);
		},
	};
}

describe("composer draft persistence", () => {
	it("keeps a session's draft for its next load and drops it once sent", () => {
		const storage = memoryStorage();
		const keys = draftKeys({ sessionFile: "/s/a.jsonl", sessionId: "a", cwd: "/p", empty: false });
		if (!keys) throw new Error("keys");
		saveDraft(storage, keys, "half a thought", { now: 10 });
		expect(loadDraft(storage, keys, 20)?.text).toBe("half a thought");
		saveDraft(storage, keys, "", { now: 30 });
		expect(loadDraft(storage, keys, 40)).toBeUndefined();
	});

	it("files drafts per device and has no key before the session is known", () => {
		const storage = memoryStorage();
		expect(draftKeys({ cwd: "/p", empty: true })).toBeUndefined();
		const local = draftKeys({ sessionFile: "/s/a.jsonl", empty: false });
		const remote = draftKeys({ device: "studio", sessionFile: "/s/a.jsonl", empty: false });
		if (!local || !remote) throw new Error("keys");
		saveDraft(storage, local, "here", { now: 1 });
		expect(loadDraft(storage, remote, 2)).toBeUndefined();
	});

	it("hands an empty session's draft to the next empty session in that folder after a relaunch, once", () => {
		const storage = memoryStorage();
		const before = draftKeys({ sessionFile: "/s/old.jsonl", cwd: "/p", empty: true });
		const after = draftKeys({ sessionFile: "/s/new.jsonl", cwd: "/p", empty: true });
		const another = draftKeys({ sessionFile: "/s/other.jsonl", cwd: "/p", empty: true });
		if (!before || !after || !another) throw new Error("keys");
		saveDraft(storage, before, "typed before quitting", { now: 100 });
		// A tab opened in this page life never copies a draft another open tab is typing.
		expect(loadDraft(storage, another, 50)).toBeUndefined();
		// After the relaunch (the page started later), the new empty session takes it, and only it.
		expect(loadDraft(storage, after, 200, 210)?.text).toBe("typed before quitting");
		expect(loadDraft(storage, another, 200, 220)).toBeUndefined();
		expect(loadDraft(storage, after, 300)?.text).toBe("typed before quitting");
	});

	it("never brings back a folder draft its session already sent", () => {
		const storage = memoryStorage();
		const typing = draftKeys({ sessionFile: "/s/a.jsonl", cwd: "/p", empty: true });
		const sent = draftKeys({ sessionFile: "/s/a.jsonl", cwd: "/p", empty: false });
		const fresh = draftKeys({ sessionFile: "/s/b.jsonl", cwd: "/p", empty: true });
		if (!typing || !sent || !fresh) throw new Error("keys");
		saveDraft(storage, typing, "first prompt", { now: 10 });
		saveDraft(storage, sent, "", { now: 20 });
		expect(loadDraft(storage, fresh, 100)).toBeUndefined();
	});

	it("survives unreadable storage", () => {
		const storage = memoryStorage();
		storage.setItem("omp.composerDrafts", "{not json");
		const keys = draftKeys({ sessionId: "a", empty: false });
		if (!keys) throw new Error("keys");
		expect(loadDraft(storage, keys, 1)).toBeUndefined();
		saveDraft(storage, keys, "fresh", { now: 2 });
		expect(loadDraft(storage, keys, 3)?.text).toBe("fresh");
	});

	describe("pictures", () => {
		const keys = draftKeys({ sessionFile: "/s/a.jsonl", empty: false });
		if (!keys) throw new Error("keys");
		const files = () => ({
			put: vi.fn(async (_id: string, _content: ComposerImage["content"]) => {}),
			read: vi.fn(async (_id: string): Promise<string | null> => null),
			remove: vi.fn(async (_id: string) => {}),
		});
		const shot: ComposerImage = {
			content: { type: "image", data: "AAAA", mimeType: "image/png" },
			preview: "data:image/png;base64,AAAA",
			name: "shot.png",
		};

		it("files a picture once by reference and brings the reference back with the draft", () => {
			const storage = memoryStorage();
			const kept = files();
			saveDraft(storage, keys, "look", { now: 1, pictures: [shot], files: kept });
			saveDraft(storage, keys, "look at this", { now: 2, pictures: [shot], files: kept });
			expect(kept.put).toHaveBeenCalledTimes(1);
			const [id, content] = kept.put.mock.calls[0] ?? [];
			expect(content).toBe(shot.content);
			expect(storage.getItem("omp.composerDrafts")).not.toContain("AAAA");
			expect(loadDraft(storage, keys, 3)).toMatchObject({
				text: "look at this",
				images: [{ id, name: "shot.png", mimeType: "image/png" }],
			});
		});

		it("keeps a picture-only draft and the reference of one that went missing", () => {
			const storage = memoryStorage();
			const kept = files();
			const missing = { ref: { id: "gone", name: "gone.png", mimeType: "image/png" }, status: "missing" as const };
			saveDraft(storage, keys, "", { now: 1, pictures: [missing], files: kept });
			expect(loadDraft(storage, keys, 2)?.images).toEqual([missing.ref]);
			expect(kept.put).not.toHaveBeenCalled();
			expect(kept.remove).not.toHaveBeenCalled();
		});

		it("deletes the kept files once the draft is sent or cleared", () => {
			const storage = memoryStorage();
			const kept = files();
			saveDraft(storage, keys, "look", { now: 1, pictures: [shot], files: kept });
			const id = kept.put.mock.calls[0]?.[0];
			saveDraft(storage, keys, "", { now: 2, files: kept });
			expect(kept.remove.mock.calls).toEqual([[id]]);
			expect(loadDraft(storage, keys, 3)).toBeUndefined();
		});

		it("deletes a picture when its draft ages out, never while a folder copy still names it", () => {
			const storage = memoryStorage();
			const kept = files();
			const first = draftKeys({ sessionFile: "/s/first.jsonl", cwd: "/p", empty: true });
			if (!first) throw new Error("keys");
			saveDraft(storage, first, "oldest", { now: 1, pictures: [shot], files: kept });
			const id = kept.put.mock.calls[0]?.[0];
			// The session entry and its folder copy are two of the 50: 48 newer drafts keep both.
			for (let i = 0; i < 48; i++) saveDraft(storage, { session: `s${i}` }, "newer", { now: 10 + i, files: kept });
			expect(kept.remove).not.toHaveBeenCalled();
			saveDraft(storage, { session: "last" }, "newest", { now: 100, files: kept });
			expect(kept.remove).not.toHaveBeenCalled();
			saveDraft(storage, { session: "later" }, "newest", { now: 101, files: kept });
			expect(kept.remove.mock.calls).toEqual([[id]]);
		});
	});
});
