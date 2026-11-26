/**
 * A take once its microphone is open: the capture (16 kHz mono float samples and a level meter), the stream to stock's
 * live session, the stop tail, the silence stop, the kept audio, and the whole-take transcription (`transcribe_audio`)
 * the fallback and Retry use. Loaded while the microphone opens (`recordAndTranscribe` in `voice.ts`), so the phone's
 * first screen does not carry it.
 */
import type { SttStreamWords } from "../../../resources/gui-bridge/stt-language-contracts";
import type { TranscribeAudioResult } from "../../shared/rpc-types";
import { captureContext, METER_BARS, STT_SAMPLE_RATE } from "./dictation-capture";
import { translate } from "./i18n";
import {
	type ActiveTake,
	classifyTranscribeError,
	type DictationFailure,
	type DictationListener,
	type DictationResult,
	dropStream,
	type KeptRecording,
	SILENCE_STOP_MS,
	STOP_TAIL_MS,
} from "./voice";

/** How often the meter publishes a level (ms): smooth enough, without a render per frame. */
const METER_INTERVAL_MS = 60;
/** Samples per callback of the capture node (at 16 kHz about a quarter second). */
const CAPTURE_FRAME = 4096;
/** How often a live take's audio goes to the stream (ms): the words keep up, and each send is a few KB. */
const STREAM_SEND_MS = 250;
/** The audio kept for Retry: ten minutes, as Orca's kept recording (`dictation-kept-recording.ts:12-13`). */
const MAX_KEPT_SAMPLES = 10 * 60 * STT_SAMPLE_RATE;
const WAV_HEADER_BYTES = 44;

// ---------------------------------------------------------------------------
// The microphone's audio
// ---------------------------------------------------------------------------

/**
 * The spectrum as {@link METER_BARS} bands of the speech range (≈ 0–4 kHz of an AnalyserNode's byte spectrum), each in
 * 0–1.
 */
function speechBandLevels(bins: Uint8Array, sampleRate: number): number[] {
	const speechBins = Math.max(METER_BARS, Math.round((4000 / (sampleRate / 2)) * bins.length));
	const perBar = Math.floor(speechBins / METER_BARS);
	const levels: number[] = [];
	for (let bar = 0; bar < METER_BARS; bar++) {
		let sum = 0;
		for (let index = bar * perBar; index < (bar + 1) * perBar; index++) sum += bins[index] ?? 0;
		levels.push(Math.min(1, sum / perBar / 200));
	}
	return levels;
}

/**
 * Linear resampling to 16 kHz across callbacks (the fractional position carries over), for a context the browser
 * would not open at 16 kHz.
 */
export function resamplerTo16k(fromRate: number): (input: Float32Array) => Float32Array {
	if (fromRate === STT_SAMPLE_RATE) return input => input;
	const step = fromRate / STT_SAMPLE_RATE;
	let offset = 0;
	return input => {
		const count = Math.max(0, Math.ceil((input.length - offset) / step));
		const out = new Float32Array(count);
		for (let k = 0; k < count; k++) {
			const at = offset + k * step;
			const index = Math.floor(at);
			const here = input[index] ?? 0;
			out[k] = here + ((input[index + 1] ?? here) - here) * (at - index);
		}
		offset += count * step - input.length;
		return out;
	};
}

/** `stream` into `context`; a browser that cannot mix rates (it throws) gets a context at its own rate, resampled. */
function sourceFor(
	stream: MediaStream,
	given: AudioContext,
): { context: AudioContext; source: MediaStreamAudioSourceNode } {
	try {
		return { context: given, source: given.createMediaStreamSource(stream) };
	} catch {
		void given.close();
		const context = new AudioContext();
		context.resume?.().catch(() => {});
		return { context, source: context.createMediaStreamSource(stream) };
	}
}

export interface MicrophoneCapture {
	/** Stop the meter and the samples, and release the microphone. */
	close(): void;
}

/**
 * Feed `stream`'s audio to `onSamples` as 16 kHz mono (each call a fresh array) and, when asked, its level to
 * `onLevels`. A ScriptProcessorNode, not a worklet: a worklet module needs a script URL the page's policy and the
 * paired page's bundle would both have to serve, and a quarter-second callback is plenty for speech. `given` (from
 * `captureContext`, made inside the press) is closed with the capture.
 */
export function captureMicrophone(
	stream: MediaStream,
	onSamples: ((samples: Float32Array) => void) | null,
	onLevels: ((levels: readonly number[]) => void) | undefined,
	given: AudioContext = captureContext(),
): MicrophoneCapture {
	const { context, source } = sourceFor(stream, given);
	const cleanups: (() => void)[] = [];
	if (onSamples) {
		const resample = resamplerTo16k(context.sampleRate);
		const processor = context.createScriptProcessor(CAPTURE_FRAME, 1, 1);
		processor.onaudioprocess = event => onSamples(resample(event.inputBuffer.getChannelData(0).slice()));
		// The node only runs while it reaches the destination; silence its output so nothing plays back.
		const mute = context.createGain();
		mute.gain.value = 0;
		source.connect(processor);
		processor.connect(mute);
		mute.connect(context.destination);
		cleanups.push(() => {
			processor.onaudioprocess = null;
			processor.disconnect();
		});
	}
	if (onLevels) {
		const analyser = context.createAnalyser();
		analyser.fftSize = 256;
		analyser.smoothingTimeConstant = 0.6;
		source.connect(analyser);
		const bins = new Uint8Array(analyser.frequencyBinCount);
		const timer = setInterval(() => {
			analyser.getByteFrequencyData(bins);
			onLevels(speechBandLevels(bins, context.sampleRate));
		}, METER_INTERVAL_MS);
		cleanups.push(() => clearInterval(timer));
	}
	return {
		close: () => {
			for (const cleanup of cleanups) cleanup();
			source.disconnect();
			void context.close();
			for (const track of stream.getTracks()) track.stop();
		},
	};
}

/** The inputs the page may name (labels only once the microphone was allowed; before that, empty labels). */
export async function listMicrophones(): Promise<{ deviceId: string; label: string }[]> {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return (
		devices
			// "default" and "communications" are aliases of another input (Orca's AGGREGATE_DEVICE_IDS); "" is unnamed before permission.
			.filter(device => device.kind === "audioinput" && !["default", "communications", ""].includes(device.deviceId))
			.map(device => ({ deviceId: device.deviceId, label: device.label }))
	);
}

// ---------------------------------------------------------------------------
// PCM16 and WAV (mirrors encodeWav in the agent's tts/wav.ts; the GUI has no runtime dependency on the agent package)
// ---------------------------------------------------------------------------

/** Float samples as little-endian PCM16 into `view` from `offset`. */
function writePcm16(samples: Float32Array, view: DataView, offset: number): void {
	for (let i = 0; i < samples.length; i += 1) {
		const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
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
	for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	return btoa(binary);
}

// ---------------------------------------------------------------------------
// The take
// ---------------------------------------------------------------------------

function keep(recording: KeptRecording, samples: Float32Array): void {
	const room = MAX_KEPT_SAMPLES - recording.samples;
	if (room < samples.length) recording.complete = false;
	if (room <= 0) return;
	const kept = samples.length > room ? samples.subarray(0, room) : samples;
	recording.chunks.push(kept);
	recording.samples += kept.length;
}

function heard(data: unknown): { text: string; language?: string } {
	const result = data as TranscribeAudioResult | undefined;
	return { text: result?.text ?? "", ...(result?.language ? { language: result.language } : {}) };
}

function failed(error: string, failure: DictationFailure, kept: KeptRecording): DictationResult {
	return { error, failure, ...(kept.complete && kept.samples > 0 ? { kept } : {}) };
}

/** Where `voice.ts` keeps the take in flight, so its stop and cancel reach it. */
export interface TakeSlot {
	hold(take: ActiveTake): void;
	release(take: ActiveTake): void;
	/** A stop came while the microphone still opened. */
	stopFirst: boolean;
}

/**
 * Hear `stream` until the slot's take is stopped (or nobody speaks for {@link SILENCE_STOP_MS}), streaming the audio
 * to stock's live session (`streamOpening`; null: none) so `onWords` follows the speech, and resolve with the
 * transcript; without a stream, or once it failed, the take is transcribed whole.
 */
export async function runTake(
	stream: MediaStream,
	context: AudioContext,
	listener: DictationListener,
	streamOpening: Promise<string | null>,
	slot: TakeSlot,
): Promise<DictationResult> {
	const kept: KeptRecording = { chunks: [], samples: 0, complete: true };
	let unsent: Float32Array[] = [];
	let streamId: string | null = null;
	/** No stream, or it failed mid-take: the take is transcribed whole instead. */
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
		context,
	);

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
		if (!id) {
			streamLost = true;
			unsent = [];
		}
	});

	slot.hold(take);
	listener.onRecording?.();
	if (slot.stopFirst) take.stop(true);
	await ended.promise;
	clearInterval(sender);
	capture.close();
	slot.release(take);
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

/**
 * A take transcribed whole (`transcribe_audio`): it waits for the language's model to download, and meanwhile
 * `onPreparing` says how far it got (the prepare loop loads on the first wait, off the phone's first screen).
 */
export async function transcribeKept(
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
