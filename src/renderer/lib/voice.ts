/**
 * Voice in/out for the GUI (agent settings `stt.*` / `speech.*`).
 *
 * Mirrors the TUI voice paths:
 * - STT (stt-controller): the microphone is captured as 16 kHz mono PCM (the pipeline's native rate,
 *   `dictation-capture.ts`) and streamed to stock's live session (`stt_stream_*`: the worker's endpointer commits
 *   segments as the speaker pauses, so the words show while speaking). A model still downloading, or an omp without
 *   the stream, gets the whole take as a canonical WAV (`transcribe_audio`), as does Retry of a failed take.
 * - Speech (vocalizer/event-controller): `speech.mode` decides what gets
 *   spoken — "assistant" speaks finalized assistant text, "all" also speaks
 *   tool-result text, "yield" speaks only the last assistant message of a
 *   run. Synthesis runs on the sidecar's local TTS (`synthesize_speech` RPC);
 *   playback is a plain Audio element.
 *
 * Playback policy: one utterance at a time — a speak request arriving while
 * another is still synthesizing or playing is DROPPED (documented choice;
 * the TUI vocalizer chains utterances, the GUI keeps the transport simple).
 */
import type { SttStreamStart } from "../../../resources/gui-bridge/stt-language-contracts";
import type { SynthesizeSpeechResult } from "../../shared/rpc-types";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { toastError } from "../stores/toast";
import { captureContext, chosenMicrophone, METER_BARS, openMicrophone } from "./dictation-capture";
import { translate } from "./i18n";
import { messageText } from "./messages";

export { METER_BARS };

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	// A fresh ArrayBuffer keeps the type BlobPart-compatible
	// (Uint8Array<ArrayBufferLike> is rejected under TS's generic ArrayBuffer).
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Read one agent setting at decision time (never cached across a run). */
async function readSetting(path: string): Promise<unknown> {
	try {
		const response = await window.omp.rpc.getSettings([path]);
		if (!response.success) return undefined;
		return (response.data as { values?: Record<string, unknown> } | undefined)?.values?.[path];
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Mic dictation (stt.enabled, stt.submitTrigger)
// ---------------------------------------------------------------------------

/** One take in flight: what a stop (with or without the tail) and a cancel do to it. */
export interface ActiveTake {
	stop(withTail: boolean): void;
	cancel(): void;
}

let activeTake: ActiveTake | null = null;
/** `getUserMedia` is still opening the mic; a cancel then lands once it has. */
let startPending = false;
let cancelBeforeStart = false;
/** A held press released while the mic still opens: the take ends (with its tail) once it has. */
let stopBeforeStart = false;

/** The words of a live take so far: what stock's endpointer committed, then the segment still being spoken. */
export interface DictationWords {
	text: string;
	partial: string;
}

/** What the composer shows while dictating (all optional). */
export interface DictationListener {
	/** The mic is open and capturing (after the permission prompt and device start). */
	onRecording?: () => void;
	/** Mic level as {@link METER_BARS} bars in 0–1, a few times a second while capturing. */
	onLevels?: (levels: readonly number[]) => void;
	/** A live take's words, as they change. */
	onWords?: (words: DictationWords) => void;
	/** Capture ended with audio; the take is being transcribed. */
	onTranscribing?: () => void;
	/**
	 * The take waits for the speech model its language needs: how far that model's download got; null once it is here
	 * (the take is then being transcribed on it).
	 */
	onPreparing?: (download: SpeechModelDownload | null) => void;
	/** A held key or mic button records: silence never ends the take then (Orca's `isHolding`). */
	isHolding?: () => boolean;
}

/** The speech model a take's language needs, downloading: its language (a code) and how far it got (0–100). */
export interface SpeechModelDownload {
	language: string | null;
	percent: number;
}

/**
 * Capture goes on this long after a stop, so the word being finished reaches the recognizer (Orca's stop tail,
 * `use-audio-capture-stop-tail.ts:7-8`, 250 ms; here 300).
 */
export const STOP_TAIL_MS = 300;
/** A take nobody speaks into for this long ends by itself (Orca's `DEFAULT_STOP_AFTER_SILENCE_SECONDS`, 60). */
export const SILENCE_STOP_MS = 60_000;

/** A take's audio, in memory only, so a failed transcription can be tried again. */
export interface KeptRecording {
	chunks: Float32Array[];
	samples: number;
	/** False once audio past the cap was dropped: a retry would lose words. */
	complete: boolean;
}

/** End the take in flight: capture goes on for {@link STOP_TAIL_MS}, then the take is transcribed. */
export function stopVoiceRecording(): void {
	if (activeTake) activeTake.stop(true);
	else if (startPending) stopBeforeStart = true;
}

/** Discard the take without transcribing (Esc while dictating, composer unmount); also while the mic still opens. */
export function cancelVoiceRecording(): void {
	if (activeTake) activeTake.cancel();
	else if (startPending) cancelBeforeStart = true;
}

/** Why a take failed, as far as the browser and the sidecar say; the composer maps each to its own message and next step. */
export type DictationFailure = "denied" | "no-device" | "in-use" | "busy" | "empty" | "no-model" | "failed";

export type DictationResult =
	/** `endedBy: "silence"`: nobody spoke for {@link SILENCE_STOP_MS} and the take ended itself. */
	| { text: string; language?: string; endedBy?: "silence" }
	/** `kept`: the whole take, for Retry (none when nothing was recorded or part of it was dropped). */
	| { error: string; failure?: DictationFailure; kept?: KeptRecording };

/** `getUserMedia` rejections by DOMException name (Chromium: NotAllowedError, NotFoundError, NotReadableError). */
export function classifyMicError(cause: unknown): DictationFailure {
	const name = typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
	if (/^(NotAllowedError|SecurityError|PermissionDeniedError)$/.test(name)) return "denied";
	if (/^(NotFoundError|DevicesNotFoundError|OverconstrainedError)$/.test(name)) return "no-device";
	if (/^(NotReadableError|TrackStartError|AbortError)$/.test(name)) return "in-use";
	return "failed";
}

/** The sidecar's failure text: only a missing or unknown dictation model is told apart ("No stt model devices configured", "Unknown stt model: x" in stock); the rest stays "failed". */
export function classifyTranscribeError(message: string): DictationFailure {
	if (
		/\bunknown (stt|dictation|speech) model\b|\b(no|missing|unset)\b[^.]*\b(dictation|stt|transcription)\b[^.]*\b(model|role)\b|\b(dictation|stt|transcription)\s+(model|role)\b[^.]*\b(not|unset|missing|configured|found|available)\b/i.test(
			message,
		)
	)
		return "no-model";
	return "failed";
}

/** Load the dictation model ahead of the first take (stock's `#warmModel`); an omp without it, or offline, says nothing. */
export function warmDictation(): void {
	window.omp.rpc.sttWarm().catch(() => {});
}

/** A live take on stock's stream, or null: the model is still downloading, or this omp has no stream. */
async function openStream(): Promise<string | null> {
	try {
		const response = await window.omp.rpc.sttStreamStart();
		return response.success ? ((response.data as SttStreamStart | undefined)?.streamId ?? null) : null;
	} catch {
		return null;
	}
}

/** Let a take's stream go (discarded, empty, or transcribed whole instead). */
export function dropStream(id: string | null): void {
	if (id) window.omp.rpc.sttStreamCancel(id).catch(() => {});
}

/**
 * Capture the chosen microphone until {@link stopVoiceRecording} fires (or nobody speaks for {@link SILENCE_STOP_MS}),
 * streaming the audio to stock's live session so `onWords` follows the speech, and resolve with the transcript.
 * `{ error }` is empty when the take was discarded; otherwise `failure` says why, and `kept` holds the take for
 * {@link retryTranscription}. `listener` follows the phases for the composer's bar.
 */
export async function recordAndTranscribe(listener: DictationListener = {}): Promise<DictationResult> {
	if (activeTake || startPending) return { error: translate("voice.mic.busy"), failure: "busy" };
	startPending = true;
	cancelBeforeStart = false;
	stopBeforeStart = false;
	// Made now, inside the press that started the take: WebKit keeps a context made later suspended.
	const context = captureContext();
	// The stream opens, and the take's code loads, while the mic does.
	const streamOpening = openStream();
	const live = import("./dictation-live");
	let stream: MediaStream;
	let runTake: Awaited<typeof live>["runTake"];
	try {
		[stream, { runTake }] = await Promise.all([chosenMicrophone().then(openMicrophone), live]);
	} catch (cause) {
		void context.close();
		void streamOpening.then(dropStream);
		return { error: cause instanceof Error ? cause.message : String(cause), failure: classifyMicError(cause) };
	} finally {
		startPending = false;
	}
	if (cancelBeforeStart) {
		for (const track of stream.getTracks()) track.stop();
		void context.close();
		void streamOpening.then(dropStream);
		return { error: "" };
	}
	return runTake(stream, context, listener, streamOpening, {
		hold: take => {
			activeTake = take;
		},
		release: take => {
			if (activeTake === take) activeTake = null;
		},
		stopFirst: stopBeforeStart,
	});
}

/** Transcribe a failed take's kept audio again, whole (Orca's Retry, `use-dictation-retry.ts`). */
export async function retryTranscription(
	kept: KeptRecording,
	listener: DictationListener = {},
): Promise<DictationResult> {
	listener.onTranscribing?.();
	const { transcribeKept } = await import("./dictation-live");
	return transcribeKept(kept, listener.onPreparing);
}

// ---------------------------------------------------------------------------
// `stt.submitTrigger` evaluation — mirrors evaluateSubmitTrigger in the
// agent's stt/submit-trigger.ts. Keep the two in sync.
// ---------------------------------------------------------------------------

export type SttSubmitTrigger = "never" | "release" | "release-complete" | "say-submit";

const STT_SUBMIT_TRIGGERS: Record<string, true> = {
	never: true,
	release: true,
	"release-complete": true,
	"say-submit": true,
};

/** Read the live `stt.submitTrigger` setting (schema default "never"). */
export async function readSttSubmitTrigger(): Promise<SttSubmitTrigger> {
	const value = await readSetting("stt.submitTrigger");
	return typeof value === "string" && value in STT_SUBMIT_TRIGGERS ? (value as SttSubmitTrigger) : "never";
}

/** Whether to auto-submit a dictated utterance, and how many trailing chars to strip first. */
export function evaluateSttSubmitTrigger(
	utterance: string,
	trigger: SttSubmitTrigger,
): { submit: boolean; trimTrailing: number } {
	const trimmed = utterance.trim();
	if (!trimmed) return { submit: false, trimTrailing: 0 };
	if (trigger === "release") {
		return { submit: trimmed.split(/\s+/).filter(Boolean).length >= 2, trimTrailing: 0 };
	}
	if (trigger === "release-complete") {
		return { submit: /[.?!…。？！]\s*$/.test(trimmed), trimTrailing: 0 };
	}
	if (trigger === "say-submit") {
		const match = utterance.match(/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i);
		if (match?.index !== undefined) return { submit: true, trimTrailing: utterance.length - match.index };
	}
	return { submit: false, trimTrailing: 0 };
}

// ---------------------------------------------------------------------------
// Speech output (speech.enabled, speech.mode, speech.voice)
// ---------------------------------------------------------------------------

let speaking = false;

/**
 * Speak one utterance through the sidecar's local TTS. Dropped silently when
 * another utterance is still active (see the module header); RPC failures
 * surface as an error toast.
 */
export function speakText(text: string): void {
	const trimmed = text.trim();
	if (!trimmed || speaking) return;
	speaking = true;
	void (async () => {
		try {
			const response = await window.omp.rpc.synthesizeSpeech(trimmed);
			if (!response.success) {
				toastError({ title: translate("voice.speak.failed"), error: response });
				return;
			}
			const data = response.data as SynthesizeSpeechResult | undefined;
			if (!data?.audioBase64) return;
			const url = URL.createObjectURL(
				new Blob([base64ToBytes(data.audioBase64)], { type: data.mimeType || "audio/wav" }),
			);
			const audio = new Audio(url);
			const playback = Promise.withResolvers<void>();
			const finish = (): void => {
				URL.revokeObjectURL(url);
				playback.resolve();
			};
			audio.onended = finish;
			audio.onerror = finish;
			// Autoplay-policy rejections are not user-facing failures.
			audio.play().catch(finish);
			await playback.promise;
		} catch (cause) {
			toastError({ title: translate("voice.speak.failed"), error: cause });
		} finally {
			speaking = false;
		}
	})();
}

// ---------------------------------------------------------------------------
// Auto-speak watcher: finalized store messages → speakText, gated on
// `speech.enabled` (synced store) and `speech.mode` (read at decision time).
// ---------------------------------------------------------------------------

/**
 * Subscribe to the messages store and speak new finalized output while
 * `speech.enabled` is on (TUI event-controller parity):
 * - assistant|all: each finalized assistant message speaks as it lands
 *   (all also speaks tool-result text);
 * - yield: only the last assistant message of a run speaks, when the run
 *   goes idle.
 * Returns the unsubscribe function.
 */
export function startVoiceAutoSpeak(): () => void {
	// Last assistant text of the in-flight run, buffered SYNCHRONOUSLY as
	// messages land and spoken at run end (yield mode). Must not wait on the
	// async mode read: agent_end flips isStreaming in the same batch tick as
	// the final message_end append, ahead of any awaited continuation.
	let lastRunAssistantText: string | null = null;

	const unsubscribeMessages = useMessagesStore.subscribe((state, previous) => {
		// lastAppended changes only on genuinely new finalized messages —
		// hydration/pagination replaces `messages` without touching it, so
		// history is never spoken.
		if (state.lastAppended === previous.lastAppended) return;
		const appended = state.lastAppended;
		for (const message of appended) {
			// TUI: never speak the aborted partial.
			if (message.role === "assistant" && message.stopReason !== "aborted") {
				const text = messageText(message);
				if (text) lastRunAssistantText = text;
			}
		}
		void (async () => {
			if (!useSettingsStore.getState().speechEnabled) return;
			const modeValue = await readSetting("speech.mode");
			// Yield messages are spoken by the run-end watcher below.
			if (modeValue === "yield") return;
			const all = modeValue === "all";
			for (const message of appended) {
				if (message.stopReason === "aborted") continue;
				const isAssistant = message.role === "assistant";
				if (!isAssistant && !(all && message.role === "toolResult")) continue;
				const text = messageText(message);
				if (text) speakText(text);
			}
		})();
	});

	const unsubscribeSession = useSessionStore.subscribe((state, previous) => {
		// Run end (agent_end): yield mode speaks the run's final assistant text.
		if (!previous.isStreaming || state.isStreaming) return;
		const pending = lastRunAssistantText;
		lastRunAssistantText = null;
		if (!pending || !useSettingsStore.getState().speechEnabled) return;
		void (async () => {
			if ((await readSetting("speech.mode")) !== "yield") return;
			speakText(pending);
		})();
	});

	return () => {
		unsubscribeMessages();
		unsubscribeSession();
	};
}
