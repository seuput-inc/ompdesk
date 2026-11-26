/**
 * One dictation take's state for whatever surface shows it (the composer's bar, the pill over another field): its
 * phase, the meter, the words while speaking, the model download it waits on, and the failure it ended in, with
 * Retry from the kept audio. The text, tidied (`lib/dictation-text.ts`), goes to `deliver`; where it lands is the
 * surface's business.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { DictationPhase } from "../components/layout/composer/DictationOverlay";
import { DictationPress } from "../lib/dictation-press";
import { polishDictation } from "../lib/dictation-text";
import { translate } from "../lib/i18n";
import { isImeKeyEvent } from "../lib/ime";
import {
	cancelVoiceRecording,
	type DictationFailure,
	type DictationListener,
	type DictationResult,
	type DictationWords,
	type KeptRecording,
	METER_BARS,
	recordAndTranscribe,
	retryTranscription,
	SILENCE_STOP_MS,
	type SpeechModelDownload,
	stopVoiceRecording,
} from "../lib/voice";
import { toast } from "../stores/toast";

/** A take that ended in an error: the kind picks the message and next step, `detail` is the raw cause. */
export interface DictationFailureView {
	kind: DictationFailure;
	detail: string;
	/** Retry transcribes the take again from its kept audio (absent when nothing whole was kept). */
	retry?: () => void;
}

export interface DictationTake {
	phase: DictationPhase;
	levels: readonly number[];
	startedAt: number | null;
	/** While transcribing: how far the language's speech model got; null when it is here. */
	preparing: SpeechModelDownload | null;
	/** A live take's words so far; null before the first. */
	words: DictationWords | null;
	/** The last take's error, shown until dismissed or the next take starts. */
	failure: DictationFailureView | null;
	dismissFailure: () => void;
	/** Start a take, or end the one in flight (a click on the mic). */
	toggle: () => void;
	/** The mic button or the `voice.dictate` key went down / up: a tap toggles, a press held 300 ms records until release. */
	pressDown: () => void;
	pressUp: () => void;
	/** End the take: the words land once transcribed. */
	stop: () => void;
}

const SILENT: readonly number[] = Array(METER_BARS).fill(0);

/** A take is starting or recording: a press now ends it. */
function underway(phase: DictationPhase): boolean {
	return phase === "starting" || phase === "recording";
}

export function useDictationTake({
	deliver,
	mountedRef,
}: {
	/** The tidied words of a finished take (empty when nothing was heard). */
	deliver: RefObject<(text: string) => void>;
	mountedRef: RefObject<boolean>;
}): DictationTake {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [levels, setLevels] = useState<readonly number[]>(SILENT);
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [preparing, setPreparing] = useState<SpeechModelDownload | null>(null);
	const [words, setWords] = useState<DictationWords | null>(null);
	const [failure, setFailure] = useState<DictationFailureView | null>(null);
	const dismissFailure = useCallback(() => setFailure(null), []);
	const press = useRef(new DictationPress());
	/** This surface started the take in flight: only then does its unmount discard it (another pane may be dictating). */
	const ownsTake = useRef(false);
	const phaseRef = useRef(phase);
	phaseRef.current = phase;

	useEffect(
		() => () => {
			if (ownsTake.current) cancelVoiceRecording();
		},
		[],
	);

	const listener: DictationListener = {
		onRecording: () => {
			if (!mountedRef.current) return;
			setStartedAt(Date.now());
			setPhase("recording");
		},
		onLevels: next => {
			if (mountedRef.current) setLevels(next);
		},
		onWords: next => {
			if (mountedRef.current) setWords(next);
		},
		onTranscribing: () => {
			if (mountedRef.current) setPhase("transcribing");
		},
		onPreparing: download => {
			if (mountedRef.current) setPreparing(download);
		},
		isHolding: () => press.current.holding,
	};
	const listenerRef = useRef(listener);
	listenerRef.current = listener;

	const finish = useCallback(
		async (result: DictationResult) => {
			ownsTake.current = false;
			if (!mountedRef.current) return;
			setPhase("idle");
			setStartedAt(null);
			setPreparing(null);
			setWords(null);
			setLevels(SILENT);
			if ("error" in result) {
				const kept = result.kept;
				if (result.error)
					setFailure({
						kind: result.failure ?? "failed",
						detail: result.error,
						...(kept ? { retry: () => retryRef.current(kept) } : {}),
					});
				return;
			}
			if (result.endedBy === "silence")
				toast({
					variant: "info",
					message: translate("voice.dictation.stoppedSilent", { seconds: SILENCE_STOP_MS / 1000 }),
				});
			const text = await polishDictation(result.text.trim(), result.language);
			if (mountedRef.current) deliver.current(text.trim());
		},
		[deliver, mountedRef],
	);

	const retryRef = useRef((kept: KeptRecording) => {
		setFailure(null);
		setPhase("transcribing");
		void retryTranscription(kept, listenerRef.current).then(finish);
	});

	const start = useCallback(() => {
		setFailure(null);
		setPhase("starting");
		ownsTake.current = true;
		void recordAndTranscribe(listenerRef.current).then(finish);
	}, [finish]);

	const stop = useCallback(() => {
		if (phaseRef.current === "starting") cancelVoiceRecording();
		else stopVoiceRecording();
	}, []);

	const toggle = useCallback(() => {
		if (phaseRef.current === "transcribing") return;
		if (underway(phaseRef.current)) stop();
		else start();
	}, [start, stop]);

	const pressDown = useCallback(() => {
		if (phaseRef.current === "transcribing") return;
		const action = press.current.down(performance.now(), underway(phaseRef.current));
		if (action === "stop") stop();
		else if (action === "start") start();
	}, [start, stop]);

	const pressUp = useCallback(() => {
		if (press.current.up(performance.now()) === "stop") stopVoiceRecording();
	}, []);

	// While the mic is open, Enter ends the take (transcribe and insert) and Esc discards it, before any other key
	// handler (the composer's, App's abort).
	useEffect(() => {
		if (phase !== "starting" && phase !== "recording") return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (isImeKeyEvent(event)) return;
			const finishKey = event.key === "Enter" && !event.shiftKey && phase === "recording";
			if (event.key !== "Escape" && !finishKey) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (finishKey) stopVoiceRecording();
			else cancelVoiceRecording();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [phase]);

	return {
		phase,
		levels,
		startedAt,
		preparing,
		words,
		failure,
		dismissFailure,
		toggle,
		pressDown,
		pressUp,
		stop,
	};
}
