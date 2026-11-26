/**
 * Mic dictation (stt.enabled) into the composer: a click starts or stops a take, a press held on the mic or the
 * `voice.dictate` key records until release, Enter stops and Esc discards; the words show while speaking and land at
 * the textarea caret. The send button's "Stop and send" and the stt.submitTrigger setting submit the utterance (TUI
 * parity).
 */
import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import { type DictationTake, useDictationTake } from "../../../hooks/use-dictation-take";
import { evaluateSttSubmitTrigger, readSttSubmitTrigger, stopVoiceRecording, warmDictation } from "../../../lib/voice";
import { useSettingsStore } from "../../../stores/settings";

export type { DictationFailureView } from "../../../hooks/use-dictation-take";

export interface ComposerDictation extends DictationTake {
	/** "Stop and send": end the take and submit the draft once it is transcribed into it. */
	stopAndSend: () => void;
}

/** The window event the `voice.dictate` key sends the composer of the tab it names (DictationHost). */
export const DICTATE_EVENT = "omp:dictate";

export interface DictateDetail {
	tabId: string;
	press: "down" | "up";
}

export function useComposerDictation({
	textareaRef,
	placeDraft,
	sendRef,
	mountedRef,
	runtimeTabId,
}: {
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeDraft: (next: string, caret: number) => void;
	/** The send of the latest render: a take transcribed later sends what the composer holds then (pictures, mode, run). */
	sendRef: RefObject<(overrideText?: string) => unknown>;
	mountedRef: RefObject<boolean>;
	runtimeTabId: string | null;
}): ComposerDictation {
	/** "Stop and send": submit the draft once the take is transcribed into it. */
	const sendAfterDictationRef = useRef(false);
	// Reassigned each render: a take that lands later reads this render's draft helpers.
	const deliver = useRef<(utterance: string) => Promise<void>>(async () => {});
	deliver.current = async (utterance: string) => {
		const sendAfter = sendAfterDictationRef.current;
		sendAfterDictationRef.current = false;
		const trigger = await readSttSubmitTrigger();
		const evaluation = evaluateSttSubmitTrigger(utterance, trigger);
		const insert = (
			evaluation.trimTrailing > 0 ? utterance.slice(0, utterance.length - evaluation.trimTrailing) : utterance
		).trimEnd();
		if (!mountedRef.current) return;
		if (!insert) {
			// Nothing heard: "Stop and send" still sends what the draft already holds.
			if (sendAfter && textareaRef.current?.value.trim()) sendRef.current();
			return;
		}
		// Read the live DOM value/caret: the user may have typed mid-recording.
		const el = textareaRef.current;
		const current = el?.value ?? "";
		const start = el?.selectionStart ?? current.length;
		const end = el?.selectionEnd ?? start;
		const before = current.slice(0, start);
		const after = current.slice(end);
		const prefix = before.length > 0 && !before.endsWith(" ") ? " " : "";
		const suffix = after.length === 0 ? " " : "";
		const insertedText = `${prefix}${insert}${suffix}`;
		const next = `${before}${insertedText}${after}`;
		el?.focus();
		placeDraft(next, start + insertedText.length);
		if (evaluation.submit || sendAfter) sendRef.current(next);
	};
	const deliverText = useRef((text: string) => void deliver.current(text));
	const take = useDictationTake({ deliver: deliverText, mountedRef });
	// A new take starts without the last one's "Stop and send" (a take that failed never delivered to clear it).
	useEffect(() => {
		if (take.phase === "starting") sendAfterDictationRef.current = false;
	}, [take.phase]);

	const stopAndSend = useCallback(() => {
		sendAfterDictationRef.current = true;
		stopVoiceRecording();
	}, []);

	// The first take does not wait for the model's load (stock's `#warmModel`), once per tab with dictation on.
	const sttEnabled = useSettingsStore(state => state.sttEnabled);
	useEffect(() => {
		if (sttEnabled && runtimeTabId) warmDictation();
	}, [sttEnabled, runtimeTabId]);

	// The `voice.dictate` key, routed here when focus is in this composer or in nothing that takes text.
	const { pressDown, pressUp } = take;
	useEffect(() => {
		const onDictate = (event: Event) => {
			const detail = (event as CustomEvent<DictateDetail>).detail;
			if (!sttEnabled || detail.tabId !== runtimeTabId) return;
			event.preventDefault();
			if (detail.press === "down") pressDown();
			else pressUp();
		};
		window.addEventListener(DICTATE_EVENT, onDictate);
		return () => window.removeEventListener(DICTATE_EVENT, onDictate);
	}, [sttEnabled, runtimeTabId, pressDown, pressUp]);

	return { ...take, stopAndSend };
}
