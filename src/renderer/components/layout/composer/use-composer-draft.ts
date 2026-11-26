/**
 * The unsent draft outlives a reload and a relaunch (draft-persistence.ts): the session's saved text and pictures
 * come back into an empty composer once the session is known, and every change is saved: after a typing pause, and
 * at once when the page is hidden or closing (`visibilitychange`, `pagehide`), so the last keystrokes survive a
 * reload. The saved text has its folded pastes expanded (their blobs live in memory). A restored picture is checked
 * on disk: one that is there comes back as an attachment, one that is not becomes an "Attach again" chip. A draft
 * past the size cap is not kept, which is said once.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { expandPasteMarkers } from "../../../lib/paste-blobs";
import {
	type ComposerStore,
	type DraftPictureRef,
	type DraftPictureSlot,
	useComposerStore,
} from "../../../stores/composer";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { toast, toastError } from "../../../stores/toast";
import { draftKeys, loadDraft, saveDraft } from "./draft-persistence";

/** Typing pause before the draft is saved for a reload or relaunch. */
const DRAFT_SAVE_MS = 300;
/** The window's localStorage; absent (tests, a locked-down page) the draft only lives in memory. */
const browserStorage: Storage | undefined = (() => {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
})();
/** Restored pictures being read now: a slot shown again (history, a queue edit) is read once more only after. */
const reading = new WeakSet<DraftPictureRef>();

export function useComposerDraft({
	text,
	pictures,
	runtimeTabId,
	device,
	sessionFile,
	sessionId,
	cwd,
	empty,
}: Parameters<typeof draftKeys>[0] & {
	text: string;
	/** The draft's pictures in order: attached ones, and restored ones still being checked or missing. */
	pictures: readonly DraftPictureSlot[];
	runtimeTabId: string | null;
}): void {
	const t = useT();
	const draftStore = useMemo(
		() => draftKeys({ device, sessionFile, sessionId, cwd, empty }),
		[device, sessionFile, sessionId, cwd, empty],
	);
	/** The session key whose saved draft was read; saving waits for it so an empty first render never erases it. */
	const [draftLoadedFor, setDraftLoadedFor] = useState<string | null>(null);
	/** The latest draft and pictures, read by the flush listeners without re-binding them per keystroke. */
	const latest = useRef({ text, pictures });
	latest.current = { text, pictures };
	/** A session whose too-large draft was already announced. */
	const announcedLarge = useRef<string | null>(null);
	/** The latest draft's save: the composer leaving the screen (a crash at the root, a closed view) flushes it. */
	const flush = useRef<(() => void) | null>(null);
	const pictureError = (name: string, error: unknown) =>
		toastError({ title: t("input.draft.pictureError", { name }), error });
	useEffect(() => {
		if (!draftStore || draftLoadedFor === draftStore.session || !browserStorage) return;
		const composer = sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer") ?? useComposerStore;
		const { draft, pictureSlots } = composer.getState();
		if (draft === "" && pictureSlots.length === 0) {
			const saved = loadDraft(browserStorage, draftStore, performance.timeOrigin);
			if (saved !== undefined) {
				composer.getState().setDraft(saved.text);
				composer.getState().restorePictureRefs(saved.images ?? []);
			}
		}
		setDraftLoadedFor(draftStore.session);
	}, [draftStore, draftLoadedFor, runtimeTabId]);
	// Each restored picture still pending is read from the keep folder: there it is the attachment, gone (or not
	// readable) it is the "Attach again" chip, whose reference stays filed for the next restore.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `pictureError` only reads `t`
	useEffect(() => {
		const files = window.omp?.draftPictures;
		if (!files) return;
		const composer = sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer") ?? useComposerStore;
		for (const slot of pictures) {
			if (!("ref" in slot) || slot.status !== "pending" || reading.has(slot.ref)) continue;
			const { ref } = slot;
			reading.add(ref);
			void files
				.read(ref.id)
				.then(
					data =>
						// Nothing back means the file is gone (a dev harness answers undefined, not null).
						!data
							? null
							: {
									content: { type: "image" as const, data, mimeType: ref.mimeType },
									preview: `data:${ref.mimeType};base64,${data}`,
									name: ref.name,
									draftRef: ref,
								},
					(error: unknown) => {
						pictureError(ref.name, error);
						return null;
					},
				)
				.then(image => {
					reading.delete(ref);
					composer.getState().resolvePictureRef(ref, image);
				});
		}
	}, [pictures, runtimeTabId, t]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `pictures` re-arms the pause; `save` reads the latest values
	useEffect(() => {
		if (!draftStore || draftLoadedFor !== draftStore.session || !browserStorage) {
			flush.current = null;
			return;
		}
		const storage = browserStorage;
		const save = () => {
			const { text: current, pictures: slots } = latest.current;
			const result = saveDraft(storage, draftStore, expandPasteMarkers(current), {
				pictures: slots,
				onError: pictureError,
			});
			if (result === "tooLarge" && announcedLarge.current !== draftStore.session) {
				announcedLarge.current = draftStore.session;
				toast({ variant: "warning", message: t("input.draft.tooLarge") });
			}
		};
		flush.current = save;
		// A sent or cleared draft is dropped at once (its kept pictures with it); typing is saved once it pauses, and
		// before the page goes (a reload for missed events or an update may come right after an upload put its path in
		// the draft).
		const timer = setTimeout(save, text ? DRAFT_SAVE_MS : 0);
		const onHidden = () => {
			if (document.visibilityState === "hidden") save();
		};
		window.addEventListener("pagehide", save);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("pagehide", save);
			document.removeEventListener("visibilitychange", onHidden);
		};
	}, [text, pictures, draftStore, draftLoadedFor, t]);
	// Unmounted with a save still pending (its timer and listeners just went): the draft is kept now.
	useEffect(() => () => flush.current?.(), []);
}
