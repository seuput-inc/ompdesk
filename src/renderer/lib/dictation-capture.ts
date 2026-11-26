/**
 * The microphone a take opens: the chosen input (Settings › Dictation, kept per device) and the audio context it is
 * heard through. What hears it (samples, meter, stream) is `dictation-live.ts`, loaded while the microphone opens.
 */

export const STT_SAMPLE_RATE = 16_000;

/** Bars in the dictation level meter. */
export const METER_BARS = 5;

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
 * The context a take hears through, made while the press that started it is still on the stack: WebKit keeps a
 * context made outside a user gesture suspended, and a suspended one hears nothing. 16 kHz when the browser allows it.
 */
export function captureContext(): AudioContext {
	let context: AudioContext;
	try {
		context = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
	} catch {
		context = new AudioContext();
	}
	context.resume?.().catch(() => {});
	return context;
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
