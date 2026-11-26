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
import type { SttStreamStart, SttStreamWords } from "../../../resources/gui-bridge/stt-language-contracts";
import type { SynthesizeSpeechResult, TranscribeAudioResult } from "../../shared/rpc-types";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { toastError } from "../stores/toast";
import { captureMicrophone, chosenMicrophone, METER_BARS, openMicrophone, STT_SAMPLE_RATE } from "./dictation-capture";
import { translate } from "./i18n";
import { messageText } from "./messages";

export { METER_BARS };

const WAV_HEADER_BYTES = 44;

// ---------------------------------------------------------------------------
// WAV (PCM16 mono) writer — mirrors encodeWav in the agent's tts/wav.ts; the
// GUI has no runtime dependency on the agent package, so keep these in sync.
// ---------------------------------------------------------------------------

/** Float samples as little-endian PCM16 into `view` from `offset`. */
function writePcm16(samples: Float32Array, view: DataView, offset: number): void {
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i]!;
		const clamped = Math.max(-1, Math.min(1, sample));
		view.setInt16(offset + i * 2, Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767), true);
	}
}

function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * 2;
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(36, "data");
	view.setUint32(40, dataBytes, true);
	writePcm16(samples, view, WAV_HEADER_BYTES);
	return new Uint8Array(buffer);
}

/** A live take's audio as `stt_stream_audio` takes it: PCM16 without a header. */
function pcm16Bytes(samples: Float32Array): Uint8Array {
	const buffer = new ArrayBuffer(samples.length * 2);
	writePcm16(samples, new DataView(buffer), 0);
	return new Uint8Array(buffer);
}

function joinSamples(chunks: readonly Float32Array[]): Float32Array {
	const joined = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}
	return joined;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

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
interface ActiveTake {
	stop(withTail: boolean): void;
	cancel(): void;
}

let activeTake: ActiveTake | null = null;
/** `getUserMedia` is still opening the mic; a cancel then lands once it has. */
let startPending = false;
let cancelBeforeStart = false;

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

/** How often a live take's audio goes to the stream (ms): the words keep up, and each send is a few KB. */
const STREAM_SEND_MS = 250;
/**
 * Capture goes on this long after a stop, so the word being finished reaches the recognizer (Orca's stop tail,
 * `use-audio-capture-stop-tail.ts:7-8`, 250 ms; here 300).
 */
export const STOP_TAIL_MS = 300;
/** A take nobody speaks into for this long ends by itself (Orca's `DEFAULT_STOP_AFTER_SILENCE_SECONDS`, 60). */
export const SILENCE_STOP_MS = 60_000;
/** The audio kept for Retry: ten minutes, as Orca's kept recording (`dictation-kept-recording.ts:12-13`). */
const MAX_KEPT_SAMPLES = 10 * 60 * STT_SAMPLE_RATE;

/** A take's audio, in memory only, so a failed transcription can be tried again. */
export interface KeptRecording {
	chunks: Float32Array[];
	samples: number;
	/** False once audio past the cap was dropped: a retry would lose words. */
	complete: boolean;
}

function keep(recording: KeptRecording, samples: Float32Array): void {
	const room = MAX_KEPT_SAMPLES - recording.samples;
	if (room < samples.length) recording.complete = false;
	if (room <= 0) return;
	const kept = samples.length > room ? samples.subarray(0, room) : samples;
	recording.chunks.push(kept);
	recording.samples += kept.length;
}

/** End the take in flight: capture goes on for {@link STOP_TAIL_MS}, then the take is transcribed. */
export function stopVoiceRecording(): void {
	activeTake?.stop(true);
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
	// The stream opens while the mic does: a model still loading queues the first words in its worker.
	const streamOpening = openStream();
	let stream: MediaStream;
	try {
		stream = await openMicrophone(await chosenMicrophone());
	} catch (cause) {
		void streamOpening.then(id => dropStream(id));
		return { error: cause instanceof Error ? cause.message : String(cause), failure: classifyMicError(cause) };
	} finally {
		startPending = false;
	}
	if (cancelBeforeStart) {
		for (const track of stream.getTracks()) track.stop();
		void streamOpening.then(id => dropStream(id));
		return { error: "" };
	}

	const kept: KeptRecording = { chunks: [], samples: 0, complete: true };
	let unsent: Float32Array[] = [];
	let streamId: string | null = null;
	/** The stream failed mid-take: the take is transcribed whole instead. */
	let streamLost = false;
	let sending: Promise<void> = Promise.resolve();
	let endedBy: "silence" | undefined;
	let cancelled = false;
	const ended = Promise.withResolvers<void>();
	/** The stop that ends capture: its tail timer, or null for one without a tail (silence). */
	let tail: ReturnType<typeof setTimeout> | null | undefined;
	const capture = captureMicrophone(
		stream,
		samples => {
			keep(kept, samples);
			if (!streamLost) unsent.push(samples);
		},
		listener.onLevels,
	);

	const send = (): Promise<void> => {
		sending = sending.then(async () => {
			if (!streamId || streamLost || unsent.length === 0) return;
			const audio = joinSamples(unsent);
			unsent = [];
			try {
				const response = await window.omp.rpc.sttStreamAudio(streamId, bytesToBase64(pcm16Bytes(audio)));
				if (!response.success) throw new Error(response.error);
				const words = response.data as SttStreamWords;
				listener.onWords?.({ text: words.text, partial: words.partial });
				if (words.quietMs >= SILENCE_STOP_MS && !listener.isHolding?.()) {
					endedBy = "silence";
					take.stop(false);
				}
			} catch {
				streamLost = true;
				unsent = [];
			}
		});
		return sending;
	};
	const sender = setInterval(() => void send(), STREAM_SEND_MS);
	void streamOpening.then(id => {
		if (cancelled) dropStream(id);
		streamId = id;
		// No stream: the take is transcribed whole from what is kept.
		if (!id) {
			streamLost = true;
			unsent = [];
		}
	});

	const take: ActiveTake = {
		stop: withTail => {
			if (tail !== undefined) return;
			if (!withTail) {
				tail = null;
				ended.resolve();
				return;
			}
			tail = setTimeout(() => ended.resolve(), STOP_TAIL_MS);
		},
		cancel: () => {
			cancelled = true;
			clearTimeout(tail ?? undefined);
			ended.resolve();
		},
	};
	activeTake = take;
	listener.onRecording?.();
	await ended.promise;
	clearInterval(sender);
	capture.close();
	if (activeTake === take) activeTake = null;
	const id = await streamOpening;
	if (cancelled) {
		dropStream(id);
		return { error: "" };
	}
	if (kept.samples === 0) {
		dropStream(id);
		return { error: translate("voice.mic.empty"), failure: "empty" };
	}
	listener.onTranscribing?.();
	await send();
	if (id && !streamLost) {
		try {
			const response = await window.omp.rpc.sttStreamStop(id);
			if (!response.success) return failed(response.error, classifyTranscribeError(response.error), kept);
			return { ...heard(response.data), endedBy };
		} catch (cause) {
			return failed(cause instanceof Error ? cause.message : String(cause), "failed", kept);
		}
	}
	dropStream(id);
	const result = await transcribeKept(kept, listener.onPreparing);
	return "text" in result ? { ...result, endedBy } : result;
}

function dropStream(id: string | null): void {
	if (id) window.omp.rpc.sttStreamCancel(id).catch(() => {});
}

function heard(data: unknown): { text: string; language?: string } {
	const result = data as TranscribeAudioResult | undefined;
	return { text: result?.text ?? "", ...(result?.language ? { language: result.language } : {}) };
}

function failed(error: string, failure: DictationFailure, kept: KeptRecording): DictationResult {
	return { error, failure, ...(kept.complete && kept.samples > 0 ? { kept } : {}) };
}

/** Transcribe a failed take's kept audio again, whole (Orca's Retry, `use-dictation-retry.ts`). */
export function retryTranscription(kept: KeptRecording, listener: DictationListener = {}): Promise<DictationResult> {
	listener.onTranscribing?.();
	return transcribeKept(kept, listener.onPreparing);
}

/**
 * A take transcribed whole (`transcribe_audio`): it waits for the language's model to download, and meanwhile
 * `onPreparing` says how far it got (the prepare loop loads on the first wait, off the phone's first screen).
 */
async function transcribeKept(
	kept: KeptRecording,
	onPreparing: DictationListener["onPreparing"],
): Promise<DictationResult> {
	let transcribed = false;
	if (onPreparing)
		void import("./stt-prepare")
			.then(({ prepareRecognition }) =>
				prepareRecognition(
					(language, percent) => {
						if (!transcribed) onPreparing({ language, percent });
					},
					() => transcribed,
				),
			)
			// Here, failed or unknown to this omp: nothing more to wait for but the pass itself.
			.then(() => {
				if (!transcribed) onPreparing(null);
			})
			.catch(() => {});
	try {
		const wav = encodeWavPcm16(joinSamples(kept.chunks), STT_SAMPLE_RATE);
		const response = await window.omp.rpc.transcribeAudio(bytesToBase64(wav), "audio/wav");
		if (!response.success) return failed(response.error, classifyTranscribeError(response.error), kept);
		return heard(response.data);
	} catch (cause) {
		return failed(cause instanceof Error ? cause.message : String(cause), "failed", kept);
	} finally {
		transcribed = true;
	}
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
