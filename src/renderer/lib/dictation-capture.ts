/**
 * The microphone as dictation hears it: the chosen input (Settings › Dictation, kept per device), 16 kHz mono float
 * samples as they arrive (stock's speech pipeline's native rate) and a level meter. Used by a take (`lib/voice.ts`) and
 * by the Settings microphone test.
 */

export const STT_SAMPLE_RATE = 16_000;

/** Bars in the dictation level meter. */
export const METER_BARS = 5;
/** How often the meter publishes a level (ms): smooth enough, without a render per frame. */
const METER_INTERVAL_MS = 60;
/** Samples per callback of the capture node (at 16 kHz about a quarter second). */
const CAPTURE_FRAME = 4096;

/** The device's chosen microphone (`dictationMicrophone`, a `deviceId`; a phone keeps its own), or none: the default. */
export async function chosenMicrophone(): Promise<string | undefined> {
	try {
		const value = await window.omp.prefs?.get("dictationMicrophone");
		return typeof value === "string" && value ? value : undefined;
	} catch {
		return undefined;
	}
}

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

/** A 16 kHz context fed by `stream`; a browser that cannot mix rates (it throws) gets its own rate and is resampled. */
function contextFor(stream: MediaStream): { context: AudioContext; source: MediaStreamAudioSourceNode } {
	try {
		const context = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
		try {
			return { context, source: context.createMediaStreamSource(stream) };
		} catch (cause) {
			void context.close();
			throw cause;
		}
	} catch {
		const context = new AudioContext();
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
 * paired page's bundle would both have to serve, and a quarter-second callback is plenty for speech.
 */
export function captureMicrophone(
	stream: MediaStream,
	onSamples: ((samples: Float32Array) => void) | null,
	onLevels?: (levels: readonly number[]) => void,
): MicrophoneCapture {
	const { context, source } = contextFor(stream);
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

/** Open the chosen microphone (`deviceId` is a preference: a device that is gone falls back to the default). */
export function openMicrophone(deviceId: string | undefined): Promise<MediaStream> {
	return navigator.mediaDevices.getUserMedia({
		audio: {
			channelCount: 1,
			echoCancellation: true,
			noiseSuppression: true,
			...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
		},
	});
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
